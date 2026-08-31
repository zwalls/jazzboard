import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";

const SHA256 = /^sha256:[a-f0-9]{64}$/;

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function readPlainSource(repositoryRoot, repositoryPath) {
  if (typeof repositoryPath !== "string" || repositoryPath.length === 0
      || path.isAbsolute(repositoryPath) || path.normalize(repositoryPath) !== repositoryPath
      || repositoryPath === "." || repositoryPath === ".." || repositoryPath.startsWith(`..${path.sep}`)) {
    throw new Error(`EXP0001A_OUTER_SOURCE_PATH_INVALID:${String(repositoryPath)}`);
  }
  const filePath = path.join(repositoryRoot, repositoryPath);
  const relative = path.relative(repositoryRoot, filePath);
  if (relative !== repositoryPath || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`EXP0001A_OUTER_SOURCE_ESCAPES_REPOSITORY:${repositoryPath}`);
  }
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new Error(`EXP0001A_OUTER_SOURCE_NOT_PLAIN_FILE:${repositoryPath}`);
  }
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try { return await handle.readFile(); } finally { await handle.close(); }
}

/**
 * Verifies the exact outer-execution bytes committed by an already
 * authority-verified Codex-native prebrief freeze. Callers must verify the
 * freeze's fixed-key signature before invoking this byte verifier.
 */
export async function verifyExp0001aOuterExecutionSourceCommitments(input) {
  const { freeze, repositoryRoot } = input ?? {};
  if (!path.isAbsolute(repositoryRoot) || path.normalize(repositoryRoot) !== repositoryRoot
      || repositoryRoot === path.parse(repositoryRoot).root) {
    throw new Error("EXP0001A_OUTER_SOURCE_REPOSITORY_ROOT_INVALID");
  }
  const commitments = freeze?.outerExecution?.sourceCommitments;
  if (!Array.isArray(commitments) || commitments.length === 0) {
    throw new Error("EXP0001A_OUTER_SOURCE_COMMITMENTS_MISSING");
  }
  const paths = commitments.map((commitment) => commitment?.path);
  if (new Set(paths).size !== paths.length) throw new Error("EXP0001A_OUTER_SOURCE_COMMITMENTS_DUPLICATED");
  const verified = [];
  for (const commitment of commitments) {
    if (commitment === null || typeof commitment !== "object" || Array.isArray(commitment)
        || Object.keys(commitment).sort().join("\0") !== "digest\0path"
        || typeof commitment.path !== "string" || !SHA256.test(commitment.digest)) {
      throw new Error("EXP0001A_OUTER_SOURCE_COMMITMENT_SCHEMA_INVALID");
    }
    const digest = sha256(await readPlainSource(repositoryRoot, commitment.path));
    if (digest !== commitment.digest) {
      throw new Error(`EXP0001A_OUTER_SOURCE_DIGEST_DRIFT:${commitment.path}`);
    }
    verified.push({ path: commitment.path, digest });
  }
  return Object.freeze({
    schemaVersion: "exp-0001a-outer-source-verification/v1",
    protocolId: "EXP-0001A",
    sourceCount: verified.length,
    sourceCommitmentsDigest: sha256(Buffer.from(canonicalJson(verified), "utf8")),
  });
}
