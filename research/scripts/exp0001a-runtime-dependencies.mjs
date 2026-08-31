#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "../..");

export const EXP0001A_RUNTIME_DEPENDENCY_RECEIPT_PATH =
  "research/data/exp0001a-runtime-dependencies-v1.json";
export const EXP0001A_RUNTIME_DEPENDENCY_VERIFIER_PATH =
  "research/scripts/exp0001a-runtime-dependencies.mjs";
export const EXP0001A_RUNTIME_DEPENDENCY_COMPONENT_IDS = Object.freeze([
  "chromiumRuntime",
  "detectLibcPackage",
  "nodeExecutable",
  "playwrightCorePackage",
  "playwrightPackage",
  "sharpColourPackage",
  "sharpLibvipsPackage",
  "sharpNativePackage",
  "sharpPackage",
]);
export const EXP0001A_FORBIDDEN_RUNTIME_ENVIRONMENT = Object.freeze([
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "LD_PRELOAD",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PLAYWRIGHT_BROWSERS_PATH",
  "PLAYWRIGHT_NODEJS_PATH",
  "SHARP_FORCE_GLOBAL_LIBVIPS",
  "SHARP_IGNORE_GLOBAL_LIBVIPS",
]);

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const CRITICAL_EXTENSIONS = new Set([".cjs", ".dylib", ".js", ".json", ".mjs", ".node"]);

function compareCodeUnits(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    .join(",")}}`;
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function modeOf(stat) {
  return (stat.mode & 0o7777).toString(8).padStart(4, "0");
}

function sameOpenFile(before, after) {
  return before.dev === after.dev
    && before.ino === after.ino
    && before.size === after.size
    && before.mtimeMs === after.mtimeMs
    && before.mode === after.mode;
}

async function plainFileLeaf(absolutePath, relativePath) {
  const handle = await open(absolutePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`Runtime dependency is not a plain file: ${relativePath}`);
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (!sameOpenFile(before, after) || bytes.byteLength !== after.size) {
      throw new Error(`Runtime dependency changed while it was being read: ${relativePath}`);
    }
    return {
      path: relativePath,
      kind: "file",
      mode: modeOf(after),
      bytes: bytes.byteLength,
      digest: sha256(bytes),
    };
  } finally {
    await handle.close();
  }
}

function insideRoot(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function treeEntries(root, current = "") {
  const absolute = current ? path.join(root, current) : root;
  const directoryStat = await lstat(absolute);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error(`Runtime dependency tree contains an invalid directory: ${current || "<root>"}`);
  }
  const output = [];
  const entries = await readdir(absolute, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => compareCodeUnits(left.name, right.name))) {
    const relative = current ? `${current}/${entry.name}` : entry.name;
    if (relative.includes("\\") || relative.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error(`Runtime dependency contains an unsafe relative path: ${relative}`);
    }
    const child = path.join(root, ...relative.split("/"));
    const stat = await lstat(child);
    if (stat.isSymbolicLink()) {
      const target = await readlink(child);
      if (path.isAbsolute(target) || !insideRoot(root, path.resolve(path.dirname(child), target))) {
        throw new Error(`Runtime dependency symlink escapes its component: ${relative}`);
      }
      output.push({
        path: relative,
        kind: "symlink",
        mode: modeOf(stat),
        target,
        bytes: Buffer.byteLength(target),
        digest: sha256(Buffer.from(target, "utf8")),
      });
      continue;
    }
    if (stat.isDirectory()) {
      output.push({ path: relative, kind: "directory", mode: modeOf(stat), bytes: 0, digest: null });
      output.push(...await treeEntries(root, relative));
      continue;
    }
    if (!stat.isFile()) throw new Error(`Runtime dependency contains a special file: ${relative}`);
    output.push(await plainFileLeaf(child, relative));
  }
  return output;
}

function isCriticalEntry(entry) {
  if (entry.kind === "symlink") return true;
  if (entry.kind !== "file") return false;
  return (Number.parseInt(entry.mode, 8) & 0o111) !== 0
    || CRITICAL_EXTENSIONS.has(path.posix.extname(entry.path).toLowerCase());
}

function rootForEntries(scope, entries) {
  return sha256(canonicalJson({
    schemaVersion: "exp-0001a-runtime-dependency-tree/v1",
    scope,
    entries,
  }));
}

async function captureComponent(location) {
  const rootStat = await lstat(location.absolutePath);
  if (rootStat.isSymbolicLink()) throw new Error(`Runtime dependency root is a symlink: ${location.id}`);
  const resolved = await realpath(location.absolutePath);
  if (resolved !== path.resolve(location.absolutePath)) {
    throw new Error(`Runtime dependency root does not resolve exactly: ${location.id}`);
  }
  const entries = location.kind === "file"
    ? [await plainFileLeaf(resolved, "$file")]
    : await treeEntries(resolved);
  const ordered = entries.sort((left, right) => compareCodeUnits(left.path, right.path));
  const critical = ordered.filter(isCriticalEntry);
  return {
    id: location.id,
    kind: location.kind,
    version: location.version,
    entryCount: ordered.length,
    fileCount: ordered.filter((entry) => entry.kind === "file").length,
    symlinkCount: ordered.filter((entry) => entry.kind === "symlink").length,
    totalBytes: ordered.reduce((sum, entry) => sum + entry.bytes, 0),
    treeRoot: rootForEntries("complete", ordered),
    criticalEntryCount: critical.length,
    criticalBytes: critical.reduce((sum, entry) => sum + entry.bytes, 0),
    criticalRoot: rootForEntries("critical-load-and-executable-subset", critical),
  };
}

async function captureCriticalComponent(location) {
  const rootStat = await lstat(location.absolutePath);
  if (rootStat.isSymbolicLink()) throw new Error(`Runtime dependency root is a symlink: ${location.id}`);
  const resolved = await realpath(location.absolutePath);
  if (resolved !== path.resolve(location.absolutePath)) {
    throw new Error(`Runtime dependency root does not resolve exactly: ${location.id}`);
  }
  const allEntries = location.kind === "file"
    ? [await plainFileLeaf(resolved, "$file")]
    : await treeEntries(resolved);
  const critical = allEntries.filter(isCriticalEntry)
    .sort((left, right) => compareCodeUnits(left.path, right.path));
  return {
    id: location.id,
    criticalEntryCount: critical.length,
    criticalBytes: critical.reduce((sum, entry) => sum + entry.bytes, 0),
    criticalRoot: rootForEntries("critical-load-and-executable-subset", critical),
  };
}

function assertExactLocations(locations) {
  if (!Array.isArray(locations) || locations.length !== EXP0001A_RUNTIME_DEPENDENCY_COMPONENT_IDS.length) {
    throw new Error("EXP-0001A runtime dependency locations must contain the exact component denominator.");
  }
  const ids = locations.map((location) => location?.id);
  if (canonicalJson(ids) !== canonicalJson(EXP0001A_RUNTIME_DEPENDENCY_COMPONENT_IDS)) {
    throw new Error("EXP-0001A runtime dependency locations must be uniquely sorted by logical component ID.");
  }
  for (const location of locations) {
    if (!location || !["file", "tree"].includes(location.kind)
        || typeof location.absolutePath !== "string" || !path.isAbsolute(location.absolutePath)
        || typeof location.version !== "string" || !location.version) {
      throw new Error(`Runtime dependency location is invalid: ${location?.id ?? "unknown"}`);
    }
  }
}

async function stableCapture(locations, capture) {
  const startedAtMs = Date.now();
  const first = [];
  for (const location of locations) first.push(await capture(location));
  const second = [];
  for (const location of locations) second.push(await capture(location));
  if (canonicalJson(first) !== canonicalJson(second)) {
    throw new Error("Runtime dependency bytes changed across the mandatory double-read verification.");
  }
  return { components: first, durationMs: Date.now() - startedAtMs };
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

export function parseExp0001aRuntimeDependencyReceipt(raw) {
  const componentKeys = [
    "id", "kind", "version", "entryCount", "fileCount", "symlinkCount", "totalBytes",
    "treeRoot", "criticalEntryCount", "criticalBytes", "criticalRoot",
  ];
  if (!exactKeys(raw, [
    "schemaVersion", "protocolId", "capturedAt", "host", "policy", "components",
    "componentSetRoot", "captureVerificationDurationMs", "receiptDigest",
  ])
      || raw.schemaVersion !== "exp-0001a-runtime-dependencies/v1"
      || raw.protocolId !== "EXP-0001A"
      || typeof raw.capturedAt !== "string" || !Number.isFinite(Date.parse(raw.capturedAt))
      || !Number.isSafeInteger(raw.captureVerificationDurationMs) || raw.captureVerificationDurationMs < 0
      || !exactKeys(raw.host, ["nodeVersion", "platform", "architecture", "operatingSystemBuild"])
      || typeof raw.host.nodeVersion !== "string" || !raw.host.nodeVersion
      || typeof raw.host.platform !== "string" || !raw.host.platform
      || typeof raw.host.architecture !== "string" || !raw.host.architecture
      || typeof raw.host.operatingSystemBuild !== "string" || !raw.host.operatingSystemBuild
      || !exactKeys(raw.policy, [
        "absolutePathsPublished", "fullTreeVerification", "criticalVerification",
        "criticalSelection", "forbiddenEnvironmentVariables",
      ])
      || raw.policy.absolutePathsPublished !== false
      || raw.policy.fullTreeVerification !== "two-identical-captures-before-runtime-import"
      || raw.policy.criticalVerification !== "two-identical-captures-before-each-attempt-before-browser-or-brief"
      || raw.policy.criticalSelection !== "symlinks-or-executable-bit-or-js-json-native-dylib-extension"
      || canonicalJson(raw.policy.forbiddenEnvironmentVariables) !== canonicalJson(EXP0001A_FORBIDDEN_RUNTIME_ENVIRONMENT)
      || !Array.isArray(raw.components)
      || raw.components.length !== EXP0001A_RUNTIME_DEPENDENCY_COMPONENT_IDS.length
      || canonicalJson(raw.components.map((component) => component?.id))
        !== canonicalJson(EXP0001A_RUNTIME_DEPENDENCY_COMPONENT_IDS)
      || !SHA256.test(raw.componentSetRoot) || !SHA256.test(raw.receiptDigest)) {
    throw new Error("EXP-0001A runtime dependency receipt has an invalid exact schema.");
  }
  for (const component of raw.components) {
    if (!exactKeys(component, componentKeys)
        || !["file", "tree"].includes(component.kind)
        || typeof component.version !== "string" || !component.version
        || !["entryCount", "fileCount", "symlinkCount", "totalBytes", "criticalEntryCount", "criticalBytes"]
          .every((key) => Number.isSafeInteger(component[key]) && component[key] >= 0)
        || component.fileCount > component.entryCount || component.symlinkCount > component.entryCount
        || component.criticalEntryCount > component.entryCount
        || !SHA256.test(component.treeRoot) || !SHA256.test(component.criticalRoot)) {
      throw new Error(`EXP-0001A runtime dependency component is invalid: ${component?.id ?? "unknown"}`);
    }
  }
  if (sha256(canonicalJson(raw.components)) !== raw.componentSetRoot) {
    throw new Error("EXP-0001A runtime dependency component-set root is invalid.");
  }
  const { receiptDigest, ...content } = raw;
  if (sha256(canonicalJson(content)) !== receiptDigest) {
    throw new Error("EXP-0001A runtime dependency receipt self-digest is invalid.");
  }
  return raw;
}

export async function captureExp0001aRuntimeDependencyReceipt(input) {
  assertExactLocations(input?.locations);
  if (!input.host || !exactKeys(input.host, ["nodeVersion", "platform", "architecture", "operatingSystemBuild"])) {
    throw new Error("EXP-0001A runtime dependency capture requires the exact observed host identity.");
  }
  const capturedAt = input.capturedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(capturedAt))) throw new Error("Runtime dependency capture timestamp is invalid.");
  const stable = await stableCapture(input.locations, captureComponent);
  const content = {
    schemaVersion: "exp-0001a-runtime-dependencies/v1",
    protocolId: "EXP-0001A",
    capturedAt,
    host: input.host,
    policy: {
      absolutePathsPublished: false,
      fullTreeVerification: "two-identical-captures-before-runtime-import",
      criticalVerification: "two-identical-captures-before-each-attempt-before-browser-or-brief",
      criticalSelection: "symlinks-or-executable-bit-or-js-json-native-dylib-extension",
      forbiddenEnvironmentVariables: [...EXP0001A_FORBIDDEN_RUNTIME_ENVIRONMENT],
    },
    components: stable.components,
    componentSetRoot: sha256(canonicalJson(stable.components)),
    captureVerificationDurationMs: stable.durationMs,
  };
  return {
    receipt: { ...content, receiptDigest: sha256(canonicalJson(content)) },
    verificationDurationMs: stable.durationMs,
  };
}

export async function verifyExp0001aRuntimeDependencies(input) {
  const expected = parseExp0001aRuntimeDependencyReceipt(input?.receipt);
  assertExactLocations(input?.locations);
  if (canonicalJson(expected.host) !== canonicalJson(input.host)) {
    throw new Error("Runtime dependency host identity differs from the frozen receipt.");
  }
  const stable = await stableCapture(input.locations, captureComponent);
  if (canonicalJson(stable.components) !== canonicalJson(expected.components)) {
    throw new Error("Runtime dependency complete tree differs from the frozen receipt.");
  }
  return Object.freeze({
    receiptDigest: expected.receiptDigest,
    componentSetRoot: expected.componentSetRoot,
    verificationScope: "complete" ,
    verificationDurationMs: stable.durationMs,
  });
}

export async function verifyExp0001aCriticalRuntimeDependencies(input) {
  const expected = parseExp0001aRuntimeDependencyReceipt(input?.receipt);
  assertExactLocations(input?.locations);
  const stable = await stableCapture(input.locations, captureCriticalComponent);
  const expectedCritical = expected.components.map((component) => ({
    id: component.id,
    criticalEntryCount: component.criticalEntryCount,
    criticalBytes: component.criticalBytes,
    criticalRoot: component.criticalRoot,
  }));
  if (canonicalJson(stable.components) !== canonicalJson(expectedCritical)) {
    throw new Error("Runtime dependency critical load/executable subset differs from the frozen receipt.");
  }
  return Object.freeze({
    receiptDigest: expected.receiptDigest,
    componentSetRoot: expected.componentSetRoot,
    verificationScope: "critical-load-and-executable-subset",
    verificationDurationMs: stable.durationMs,
  });
}

async function readPackageVersion(packageRoot) {
  const bytes = await readFile(path.join(packageRoot, "package.json"));
  const value = JSON.parse(bytes.toString("utf8"));
  if (typeof value.version !== "string" || !value.version) throw new Error(`Package version is missing: ${packageRoot}`);
  return value.version;
}

export function assertExp0001aRuntimeEnvironmentOverridesAbsent(environment = process.env) {
  const present = EXP0001A_FORBIDDEN_RUNTIME_ENVIRONMENT.filter((name) => {
    const value = environment[name];
    return typeof value === "string" && value.length > 0;
  });
  if (present.length > 0) {
    throw new Error(`Forbidden runtime dependency environment overrides are present: ${present.join(", ")}`);
  }
}

export async function resolveFixedExp0001aRuntimeDependencyContext(repoRoot = REPO_ROOT) {
  assertExp0001aRuntimeEnvironmentOverridesAbsent();
  const absoluteRepoRoot = path.resolve(repoRoot);
  if (await realpath(absoluteRepoRoot) !== absoluteRepoRoot) {
    throw new Error("EXP-0001A repository root must resolve exactly without symlinks.");
  }
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("EXP-0001A runtime dependency locator is frozen to darwin arm64.");
  }
  const packageRoot = (name) => path.join(absoluteRepoRoot, "node_modules", ...name.split("/"));
  const playwrightRoot = packageRoot("playwright");
  const playwrightCoreRoot = packageRoot("playwright-core");
  const browsers = JSON.parse(await readFile(path.join(playwrightCoreRoot, "browsers.json"), "utf8"));
  const chromium = browsers?.browsers?.find((browser) => browser?.name === "chromium");
  if (!chromium || typeof chromium.revision !== "string" || typeof chromium.browserVersion !== "string") {
    throw new Error("Playwright Chromium revision metadata is missing.");
  }
  const chromiumRoot = path.join(os.homedir(), "Library", "Caches", "ms-playwright", `chromium-${chromium.revision}`);
  const nodeExecutable = await realpath(process.execPath);
  const locations = [
    { id: "chromiumRuntime", kind: "tree", absolutePath: chromiumRoot, version: chromium.browserVersion },
    { id: "detectLibcPackage", kind: "tree", absolutePath: packageRoot("detect-libc"), version: await readPackageVersion(packageRoot("detect-libc")) },
    { id: "nodeExecutable", kind: "file", absolutePath: nodeExecutable, version: process.version.replace(/^v/, "") },
    { id: "playwrightCorePackage", kind: "tree", absolutePath: playwrightCoreRoot, version: await readPackageVersion(playwrightCoreRoot) },
    { id: "playwrightPackage", kind: "tree", absolutePath: playwrightRoot, version: await readPackageVersion(playwrightRoot) },
    { id: "sharpColourPackage", kind: "tree", absolutePath: packageRoot("@img/colour"), version: await readPackageVersion(packageRoot("@img/colour")) },
    { id: "sharpLibvipsPackage", kind: "tree", absolutePath: packageRoot("@img/sharp-libvips-darwin-arm64"), version: await readPackageVersion(packageRoot("@img/sharp-libvips-darwin-arm64")) },
    { id: "sharpNativePackage", kind: "tree", absolutePath: packageRoot("@img/sharp-darwin-arm64"), version: await readPackageVersion(packageRoot("@img/sharp-darwin-arm64")) },
    { id: "sharpPackage", kind: "tree", absolutePath: packageRoot("sharp"), version: await readPackageVersion(packageRoot("sharp")) },
  ];
  assertExactLocations(locations);
  const { stdout: operatingSystemBuild } = await execFileAsync("/usr/bin/sw_vers", ["-buildVersion"], {
    encoding: "utf8",
  });
  return Object.freeze({
    locations: Object.freeze(locations.map((location) => Object.freeze(location))),
    host: Object.freeze({
      nodeVersion: process.version.replace(/^v/, ""),
      platform: process.platform,
      architecture: process.arch,
      operatingSystemBuild: operatingSystemBuild.trim(),
    }),
  });
}

export async function captureFixedExp0001aRuntimeDependencyReceipt(capturedAt = new Date().toISOString()) {
  const context = await resolveFixedExp0001aRuntimeDependencyContext(REPO_ROOT);
  return captureExp0001aRuntimeDependencyReceipt({ ...context, capturedAt });
}

async function main() {
  if (process.argv.length !== 2) {
    throw new Error("Usage: node research/scripts/exp0001a-runtime-dependencies.mjs");
  }
  const result = await captureFixedExp0001aRuntimeDependencyReceipt();
  process.stdout.write(`${canonicalJson(result.receipt)}\n`);
  process.stderr.write(`EXP-0001A full dependency double-capture duration: ${result.verificationDurationMs} ms\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
