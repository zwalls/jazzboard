#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdtemp, open, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  EXP0001A_ESBUILD_VERSION,
  EXP0001A_REQUIRED_RUNTIME_INPUTS,
  EXP0001A_RUNTIME_ENTRY,
  EXP0001A_RUNTIME_OUTPUT,
  buildExp0001aRuntimeBytes,
} from "./build-exp0001a-runtime.mjs";
import { generateExp0001aCodexReviewPlanBytes } from "./generate-exp0001a-codex-review-plan.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "../..");
export const EXP0001A_CODEX_FREEZE_PATH = "research/data/exp-0001a-codex-prebrief-freeze-v2.json";
export const EXP0001A_CODEX_FREEZE_SIGNATURE_PATH =
  "research/data/exp0001a-codex-prebrief-freeze-signature-v2.json";
const FREEZE_PATH = path.join(REPOSITORY_ROOT, EXP0001A_CODEX_FREEZE_PATH);
const SIGNATURE_PATH = path.join(REPOSITORY_ROOT, EXP0001A_CODEX_FREEZE_SIGNATURE_PATH);

function canonicalize(value, at = "$") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`Non-finite number at ${at}.`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((item, index) => canonicalize(item, `${at}/${index}`));
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`Non-plain value at ${at}.`);
    const output = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item === undefined || typeof item === "function" || typeof item === "symbol" || typeof item === "bigint") {
        throw new TypeError(`Non-JSON value at ${at}/${key}.`);
      }
      output[key] = canonicalize(item, `${at}/${key}`);
    }
    return output;
  }
  throw new TypeError(`Non-JSON value at ${at}.`);
}

export function canonicalExp0001aFreezeJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256Bytes(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function sha256Canonical(value) {
  return sha256Bytes(Buffer.from(canonicalExp0001aFreezeJson(value), "utf8"));
}

async function readPlainFile(repositoryPath) {
  const filePath = path.join(REPOSITORY_ROOT, repositoryPath);
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`EXP-0001A freeze input is not a plain file: ${repositoryPath}`);
  }
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try { return await handle.readFile(); } finally { await handle.close(); }
}

async function readJson(repositoryPath) {
  const bytes = await readPlainFile(repositoryPath);
  try { return JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`Invalid JSON: ${repositoryPath}`); }
}

async function importRuntime(bytes, digest) {
  const directory = await mkdtemp(path.join(tmpdir(), "exp0001a-freeze-runtime-"));
  const modulePath = path.join(directory, "runtime.mjs");
  await writeFile(modulePath, bytes, { mode: 0o600, flag: "wx" });
  const runtime = await import(`${pathToFileURL(modulePath).href}?digest=${encodeURIComponent(digest)}`);
  return { runtime, dispose: () => rm(directory, { recursive: true, force: true }) };
}

function assertSameStringSet(left, right, label) {
  const normalizedLeft = [...left].sort();
  const normalizedRight = [...right].sort();
  if (new Set(normalizedLeft).size !== normalizedLeft.length
      || canonicalExp0001aFreezeJson(normalizedLeft) !== canonicalExp0001aFreezeJson(normalizedRight)) {
    throw new Error(`${label} differs from the deterministic builder inventory.`);
  }
}

async function sourceCommitment(repositoryPath) {
  return Object.freeze({ path: repositoryPath, digest: sha256Bytes(await readPlainFile(repositoryPath)) });
}

export async function generateExp0001aCodexFreezeArtifacts() {
  // Reproducibility is itself part of the frozen transport. A single build can
  // faithfully commit one nondeterministic output, so require two independent
  // builds in the same invocation to agree on bytes, digest, and transitive
  // input inventory before any freeze content is derived.
  const built = await buildExp0001aRuntimeBytes();
  const rebuilt = await buildExp0001aRuntimeBytes();
  if (!Buffer.from(built.bytes).equals(Buffer.from(rebuilt.bytes))
      || built.bundleDigest !== rebuilt.bundleDigest
      || canonicalExp0001aFreezeJson(built.inputs) !== canonicalExp0001aFreezeJson(rebuilt.inputs)) {
    throw new Error("EXP-0001A runtime build is not byte-for-byte reproducible.");
  }
  const loaded = await importRuntime(built.bytes, built.bundleDigest);
  try {
    const runtime = loaded.runtime;
    const [template, executionManifest, reviewPlanBytes, retainedReviewPlanBytes, publicGate, publicEvidence, freezeV1] =
      await Promise.all([
        readJson(EXP0001A_CODEX_FREEZE_PATH),
        readJson("research/data/development-execution-manifest-v1.json"),
        generateExp0001aCodexReviewPlanBytes(),
        readPlainFile("research/data/exp0001a-codex-review-plan-v1.json"),
        readJson("research/data/exp0001a-codex-webmcp-spike-gate-public-v2.json"),
        readJson("research/data/exp0001a-codex-webmcp-spike-public-v2.json"),
        readJson("research/data/exp-0001a-prebrief-freeze-v1.json"),
      ]);
    if (!reviewPlanBytes.equals(retainedReviewPlanBytes)) {
      throw new Error("Committed Codex review plan differs from deterministic generation.");
    }
    const reviewPlan = JSON.parse(reviewPlanBytes.toString("utf8"));
    runtime.verifyExp0001aCodexReviewPlanManifest({ manifest: reviewPlan, executionManifest });
    runtime.verifyExp0001aCodexSpikeRecoveryGate(publicGate);
    // The generator supersedes the retained template's spike commitments with
    // the independently verified current v2 gate. Comparing the new signature
    // to the old template here would make legitimate fixed-authority recovery
    // impossible; the generated content below commits the exact new bytes.
    if (publicGate.evidenceDigest !== sha256Canonical(publicEvidence)
        || canonicalExp0001aFreezeJson(publicGate.evidence) !== canonicalExp0001aFreezeJson(publicEvidence)
        || publicGate.decision !== "allow") {
      throw new Error("Public signed spike gate/evidence projection is inconsistent.");
    }
    assertSameStringSet(template.activeRuntime.requiredSourcePaths, EXP0001A_REQUIRED_RUNTIME_INPUTS,
      "Frozen active runtime source inventory");
    if (!EXP0001A_REQUIRED_RUNTIME_INPUTS.includes(EXP0001A_RUNTIME_ENTRY)) {
      throw new Error("Runtime entry is absent from the required source inventory.");
    }
    const provisioningPlan = runtime.createExp0001aAttemptProvisioningPlan();
    const manifestFileBytes = await readPlainFile("research/data/development-execution-manifest-v1.json");
    const sourcePaths = template.outerExecution.sourceCommitments.map((source) => source.path);
    if (new Set(sourcePaths).size !== sourcePaths.length) throw new Error("Outer execution source inventory is duplicated.");
    const outerSourceCommitments = await Promise.all(sourcePaths.map(sourceCommitment));
    const buildScriptCommitment = await sourceCommitment("research/scripts/build-exp0001a-runtime.mjs");
    const sourceCommitments = Object.fromEntries(await Promise.all(
      Object.entries(template.sources).map(async ([name, source]) => [name, await sourceCommitment(source.path)]),
    ));
    const publicGateBytes = await readPlainFile("research/data/exp0001a-codex-webmcp-spike-gate-public-v2.json");
    const publicKeyBytes = await readPlainFile(template.authority.publicKeyPath);
    if (sha256Bytes(publicKeyBytes) !== template.authority.publicKeyDigest) {
      throw new Error("Freeze authority public key differs from the fixed trust anchor.");
    }
    const orderedAttemptIds = executionManifest.assignments.flatMap((pair) =>
      [...pair.attempts].sort((left, right) => left.orderIndex - right.orderIndex).map((attempt) => attempt.attemptId));
    const content = {
      ...template,
      supersedes: { ...template.supersedes, freezeDigest: freezeV1.freezeDigest },
      passedSpikeGate: {
        ...template.passedSpikeGate,
        publicSignedGateFileDigest: sha256Bytes(publicGateBytes),
        authoritySignaturePayloadDigest: publicGate.authoritySignature.payloadDigest,
        authoritySignatureBase64: publicGate.authoritySignature.signatureBase64,
        spikeEvidenceDigest: publicGate.evidenceDigest,
        gateDigest: publicGate.gateDigest,
        decision: publicGate.decision,
      },
      activeRuntime: {
        ...template.activeRuntime,
        bundleDigest: built.bundleDigest,
        buildScript: {
          path: buildScriptCommitment.path,
          digest: buildScriptCommitment.digest,
          esbuildVersion: EXP0001A_ESBUILD_VERSION,
        },
      },
      outerExecution: { ...template.outerExecution, sourceCommitments: outerSourceCommitments },
      schedule: {
        ...template.schedule,
        manifestFileDigest: sha256Bytes(manifestFileBytes),
        manifestDigest: executionManifest.manifestDigest,
        benchmarkBundleDigest: executionManifest.benchmark.bundleDigest,
        taskCommitmentsDigest: sha256Canonical(executionManifest.tasks),
        fixedOrderDigest: sha256Canonical(orderedAttemptIds),
        codexSchedulerDigest: provisioningPlan.scheduleDigest,
        treatmentDigest: executionManifest.treatments.A0,
        opaqueLabels: executionManifest.opaqueLabels,
        taskCount: executionManifest.taskCount,
        pairCount: executionManifest.pairCount,
        attemptCount: executionManifest.attemptCount,
        taskCommitments: executionManifest.tasks.map(({ taskId, taskDigest }) => ({ taskId, taskDigest })),
      },
      sources: sourceCommitments,
      reviewCommitments: {
        ...template.reviewCommitments,
        reviewPlanManifestFileDigest: sha256Bytes(reviewPlanBytes),
        reviewPlanManifestDigest: reviewPlan.manifestDigest,
        primaryAssignmentSeed: reviewPlan.primaryAssignmentSeed,
        primaryReviewerRosterRoot: reviewPlan.primaryReviewerRosterRoot,
        adjudicationTrigger: reviewPlan.adjudicationTrigger,
        pairwisePromptDigest: reviewPlan.pairwisePromptDigest,
        pairwiseWorkOrderDigest: reviewPlan.pairwiseAssignmentRoot,
        pairwiseRandomizationAlgorithm: reviewPlan.pairwiseRandomizationAlgorithm,
        pairwiseLeftRightRandomizationDigest: reviewPlan.pairwiseLeftRightRoot,
        pairwiseReviewerRosterRoot: reviewPlan.pairwiseReviewerRosterRoot,
        reviewerIdentityCommitmentsSourceFreezeDigest: reviewPlan.sourceFreezeDigest,
      },
    };
    delete content.freezeDigest;
    const freeze = runtime.verifyExp0001aCodexPrebriefFreeze({
      ...content,
      freezeDigest: sha256Canonical(content),
    });
    return Object.freeze({
      freeze,
      freezeBytes: Buffer.from(`${JSON.stringify(freeze, null, 2)}\n`, "utf8"),
      runtimeBytes: Buffer.from(built.bytes),
      runtimeBundleDigest: built.bundleDigest,
      transitiveRuntimeInputs: built.inputs,
    });
  } finally {
    await loaded.dispose();
  }
}

/**
 * Rebuilds the runtime twice, regenerates every freeze commitment from its
 * authoritative bytes, and byte-compares both retained artifacts.  The
 * prebrief signer calls this with `verifySignature: false` before a signature
 * can exist; normal readiness calls keep signature verification enabled.
 */
export async function verifyRetainedExp0001aCodexFreezeArtifacts(input = {}) {
  const verifySignature = input.verifySignature !== false;
  const verifiedAt = input.verifiedAt ?? new Date().toISOString();
  const artifacts = await generateExp0001aCodexFreezeArtifacts();
  const [retainedRuntime, retainedFreeze] = await Promise.all([
    readPlainFile(EXP0001A_RUNTIME_OUTPUT),
    readPlainFile(EXP0001A_CODEX_FREEZE_PATH),
  ]);
  if (!retainedRuntime.equals(artifacts.runtimeBytes)
      || !retainedFreeze.equals(artifacts.freezeBytes)) {
    throw new Error("Committed runtime/freeze differs from deterministic generation.");
  }
  if (verifySignature) {
    const signature = await readJson(EXP0001A_CODEX_FREEZE_SIGNATURE_PATH);
    const loaded = await importRuntime(artifacts.runtimeBytes, artifacts.runtimeBundleDigest);
    try {
      loaded.runtime.verifyExp0001aCodexPrebriefFreezeAuthority({
        freeze: artifacts.freeze,
        authoritySignature: signature,
        verifiedAt,
      });
    } finally {
      await loaded.dispose();
    }
  }
  return artifacts;
}

async function retainAtomic(targetPath, bytes) {
  const temporaryPath = `${targetPath}.tmp-${randomUUID()}`;
  const handle = await open(
    temporaryPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o644,
  );
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try {
    await rename(temporaryPath, targetPath);
    const directory = await open(path.dirname(targetPath), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  if (!Buffer.from(await readFile(targetPath)).equals(bytes)) throw new Error("Freeze artifact atomic readback failed.");
}

export async function runExp0001aCodexFreezeGenerator(argv = process.argv.slice(2)) {
  if (argv.length !== 1 || !["--check", "--write"].includes(argv[0])) {
    throw new Error("Usage: generate-exp0001a-codex-freeze.mjs --check | --write");
  }
  const mode = argv[0].slice(2);
  const runtimePath = path.join(REPOSITORY_ROOT, EXP0001A_RUNTIME_OUTPUT);
  let artifacts;
  if (mode === "write") {
    artifacts = await generateExp0001aCodexFreezeArtifacts();
    if (await lstat(SIGNATURE_PATH).then(() => true, (error) => error?.code === "ENOENT" ? false : Promise.reject(error))) {
      throw new Error("Signed prebrief freeze already exists; immutable freeze regeneration is forbidden.");
    }
    await retainAtomic(runtimePath, artifacts.runtimeBytes);
    await retainAtomic(FREEZE_PATH, artifacts.freezeBytes);
  } else {
    artifacts = await verifyRetainedExp0001aCodexFreezeArtifacts({ verifySignature: true });
  }
  return Object.freeze({
    mode,
    freezePath: EXP0001A_CODEX_FREEZE_PATH,
    freezeDigest: artifacts.freeze.freezeDigest,
    runtimeBundlePath: EXP0001A_RUNTIME_OUTPUT,
    runtimeBundleDigest: artifacts.runtimeBundleDigest,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  runExp0001aCodexFreezeGenerator()
    .then((result) => process.stdout.write(`${canonicalExp0001aFreezeJson(result)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
