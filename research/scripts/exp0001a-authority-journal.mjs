import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, open, readdir, unlink } from "node:fs/promises";
import path from "node:path";

export const EXP0001A_AUTHORITY_JOURNAL_VERSION = "exp-0001a-authority-journal/v1";
export const EXP0001A_AUTHORITY_JOURNAL_DIRECTORY = "authority-journal";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ENTRY_FILE = /^entry-([0-9]{6})\.json$/;
const ENTRY_TEMPORARY_FILE = /^\.(entry-[0-9]{6}\.json)-[0-9]+-[a-f0-9-]{36}\.tmp$/;
const LOCK_VERSION = "exp-0001a-authority-journal-lock/v1";
const LOCK_FILE = ".append.lock";
const LOCK_RECOVERY_FILE = ".append.lock.recovery";
const LOCK_STALE_AFTER_MS = 30_000;
const LOCK_ACQUIRE_TIMEOUT_MS = 60_000;
const LOCK_RETRY_MS = 10;

function canonicalize(value, at = "$") {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`Non-finite number at ${at}.`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map((item, index) => canonicalize(item, `${at}/${index}`));
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Only plain JSON objects are supported at ${at}.`);
    }
    const result = {};
    for (const key of Object.keys(value).sort()) {
      const item = value[key];
      if (item === undefined || typeof item === "function" || typeof item === "symbol" || typeof item === "bigint") {
        throw new TypeError(`Non-JSON value at ${at}/${key}.`);
      }
      result[key] = canonicalize(item, `${at}/${key}`);
    }
    return result;
  }
  throw new TypeError(`Non-JSON value at ${at}.`);
}

export function canonicalAuthorityJournalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function digestCanonical(value) {
  return `sha256:${createHash("sha256").update(canonicalAuthorityJournalJson(value)).digest("hex")}`;
}

async function fsyncDirectory(directory) {
  const handle = await open(directory, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function requirePrivateDirectory(directory) {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw new Error("EXP0001A_AUTHORITY_JOURNAL_DIRECTORY_NOT_PRIVATE");
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function writeFsyncedTemporaryFile(filePath, bytes) {
  const handle = await open(filePath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function processIsDefinitelyDead(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // EPERM still proves that a process owns this pid. Only ESRCH is safe for
    // stale-lock recovery; every other host response fails closed.
    return error?.code === "ESRCH";
  }
}

async function readLockSnapshot(lockPath) {
  const metadata = await lstat(lockPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (metadata === null) return null;
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600) {
    throw new Error("EXP0001A_AUTHORITY_JOURNAL_LOCK_NOT_PRIVATE_PLAIN_FILE");
  }
  const handle = await open(lockPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (handle === null) return null;
  let bytes;
  try { bytes = await handle.readFile(); } finally { await handle.close(); }
  let owner = null;
  try {
    const parsed = JSON.parse(bytes.toString("utf8"));
    if (bytes.equals(Buffer.from(`${canonicalAuthorityJournalJson(parsed)}\n`, "utf8"))
        && parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        && parsed.schemaVersion === LOCK_VERSION
        && Number.isSafeInteger(parsed.pid) && parsed.pid > 1
        && typeof parsed.acquiredAt === "string" && Number.isFinite(Date.parse(parsed.acquiredAt))
        && typeof parsed.ownerToken === "string"
        && /^[a-f0-9-]{36}$/.test(parsed.ownerToken)) {
      owner = Object.freeze(parsed);
    }
  } catch {
    // A killed legacy writer may have left a partial lock. Its age remains the
    // only safe recovery signal; a fresh malformed lock is never removed.
  }
  return Object.freeze({
    bytes,
    owner,
    device: metadata.dev,
    inode: metadata.ino,
    modifiedAtMs: metadata.mtimeMs,
  });
}

function lockSnapshotIsStale(snapshot, checkedAtMs) {
  if (checkedAtMs - snapshot.modifiedAtMs < LOCK_STALE_AFTER_MS) return false;
  if (snapshot.owner === null) return true;
  if (checkedAtMs - Date.parse(snapshot.owner.acquiredAt) < LOCK_STALE_AFTER_MS) return false;
  return processIsDefinitelyDead(snapshot.owner.pid);
}

function sameLockInode(left, right) {
  return left !== null && right !== null && left.device === right.device && left.inode === right.inode
    && left.bytes.equals(right.bytes);
}

async function removeStaleRecoverySentinel(recoveryPath, directory, checkedAtMs) {
  const snapshot = await readLockSnapshot(recoveryPath);
  if (snapshot === null || !lockSnapshotIsStale(snapshot, checkedAtMs)) return false;
  const confirmed = await readLockSnapshot(recoveryPath);
  if (!sameLockInode(snapshot, confirmed)) return false;
  await unlink(recoveryPath).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  await fsyncDirectory(directory);
  return true;
}

async function acquireAppendLock(directory) {
  const lockPath = path.join(directory, LOCK_FILE);
  const recoveryPath = path.join(directory, LOCK_RECOVERY_FILE);
  const acquiredAt = new Date().toISOString();
  const owner = Object.freeze({
    schemaVersion: LOCK_VERSION,
    pid: process.pid,
    acquiredAt,
    ownerToken: randomUUID(),
  });
  const ownerBytes = Buffer.from(`${canonicalAuthorityJournalJson(owner)}\n`, "utf8");
  const candidatePath = path.join(directory, `.append-lock-${owner.ownerToken}.tmp`);
  await writeFsyncedTemporaryFile(candidatePath, ownerBytes);
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  try {
    while (Date.now() <= deadline) {
      const checkedAtMs = Date.now();
      const recovery = await readLockSnapshot(recoveryPath);
      if (recovery !== null) {
        await removeStaleRecoverySentinel(recoveryPath, directory, checkedAtMs);
        await delay(LOCK_RETRY_MS);
        continue;
      }
      try {
        await link(candidatePath, lockPath);
        await fsyncDirectory(directory);
        const retained = await readLockSnapshot(lockPath);
        if (retained?.owner?.ownerToken !== owner.ownerToken || !retained.bytes.equals(ownerBytes)) {
          throw new Error("EXP0001A_AUTHORITY_JOURNAL_LOCK_ACQUISITION_DRIFT");
        }
        return Object.freeze({ lockPath, owner });
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }

      const stale = await readLockSnapshot(lockPath);
      if (stale !== null && lockSnapshotIsStale(stale, checkedAtMs)) {
        // The recovery sentinel belongs to this live process. It serializes
        // removers while the stale canonical name is replaced; contenders that
        // observed the old lock before the sentinel was published can at worst
        // win the new lock, never run concurrently with this process.
        try {
          await link(candidatePath, recoveryPath);
          await fsyncDirectory(directory);
        } catch (error) {
          if (error?.code !== "EEXIST" && error?.code !== "ENOENT") throw error;
          await delay(LOCK_RETRY_MS);
          continue;
        }
        try {
          const current = await readLockSnapshot(lockPath);
          if (!sameLockInode(stale, current) || !lockSnapshotIsStale(current, Date.now())) {
            continue;
          }
          await unlink(lockPath).catch((error) => {
            if (error?.code !== "ENOENT") throw error;
          });
          await fsyncDirectory(directory);
          try {
            await link(candidatePath, lockPath);
            await fsyncDirectory(directory);
            const retained = await readLockSnapshot(lockPath);
            if (retained?.owner?.ownerToken !== owner.ownerToken || !retained.bytes.equals(ownerBytes)) {
              throw new Error("EXP0001A_AUTHORITY_JOURNAL_LOCK_RECOVERY_DRIFT");
            }
            return Object.freeze({ lockPath, owner });
          } catch (error) {
            if (error?.code !== "EEXIST") throw error;
          }
        } finally {
          await unlink(recoveryPath).catch((error) => {
            if (error?.code !== "ENOENT") throw error;
          });
          await fsyncDirectory(directory).catch(() => undefined);
        }
      }
      await delay(LOCK_RETRY_MS);
    }
  } finally {
    await unlink(candidatePath).catch(() => undefined);
  }
  throw new Error("EXP0001A_AUTHORITY_JOURNAL_APPEND_LOCK_TIMEOUT");
}

async function releaseAppendLock(directory, retainedLock) {
  const snapshot = await readLockSnapshot(retainedLock.lockPath);
  if (snapshot?.owner?.ownerToken !== retainedLock.owner.ownerToken) {
    throw new Error("EXP0001A_AUTHORITY_JOURNAL_APPEND_LOCK_OWNERSHIP_LOST");
  }
  await unlink(retainedLock.lockPath);
  await fsyncDirectory(directory);
}

async function cleanupOrphanEntryTemporaries(directory) {
  let removed = false;
  for (const name of await readdir(directory)) {
    if (!ENTRY_TEMPORARY_FILE.test(name)) continue;
    const temporaryPath = path.join(directory, name);
    const metadata = await lstat(temporaryPath).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (metadata === null) continue;
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o777) !== 0o600) {
      throw new Error("EXP0001A_AUTHORITY_JOURNAL_ORPHAN_TEMPORARY_INVALID");
    }
    await unlink(temporaryPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    removed = true;
  }
  if (removed) await fsyncDirectory(directory);
}

async function publishEntryNoClobber(directory, filePath, entry, bytes) {
  const temporaryPath = path.join(directory,
    `.${path.basename(filePath)}-${process.pid}-${randomUUID()}.tmp`);
  let temporaryRetained = true;
  try {
    await writeFsyncedTemporaryFile(temporaryPath, bytes);
    try {
      await link(temporaryPath, filePath);
      await unlink(temporaryPath);
      temporaryRetained = false;
      await fsyncDirectory(directory);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const retained = verifyEntry(await readPlainEntry(filePath), entry.sequence, entry.priorEntryDigest);
      if (canonicalAuthorityJournalJson(retained) !== canonicalAuthorityJournalJson(entry)) {
        throw new Error("EXP0001A_AUTHORITY_JOURNAL_ENTRY_COLLISION");
      }
    }
  } finally {
    if (temporaryRetained) await unlink(temporaryPath).catch(() => undefined);
  }
}

async function readPlainEntry(filePath) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink > 2 || (metadata.mode & 0o777) !== 0o600) {
    throw new Error("EXP0001A_AUTHORITY_JOURNAL_ENTRY_NOT_PRIVATE_PLAIN_FILE");
  }
  if (metadata.nlink === 2) {
    // A SIGKILL after the no-clobber link but before temporary unlink leaves
    // exactly one private sibling name pointing at the complete fsynced inode.
    // Accept only that narrowly recognizable publication prefix; arbitrary
    // external hard links still fail closed.
    const escaped = path.basename(filePath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const temporaryPattern = new RegExp(`^\\.${escaped}-[0-9]+-[a-f0-9-]{36}\\.tmp$`);
    const siblings = await readdir(path.dirname(filePath));
    const matching = [];
    for (const name of siblings.filter((candidate) => temporaryPattern.test(candidate))) {
      const sibling = await lstat(path.join(path.dirname(filePath), name));
      if (sibling.isFile() && !sibling.isSymbolicLink()
          && sibling.dev === metadata.dev && sibling.ino === metadata.ino) matching.push(name);
    }
    if (matching.length !== 1) {
      throw new Error("EXP0001A_AUTHORITY_JOURNAL_ENTRY_NOT_PRIVATE_PLAIN_FILE");
    }
  }
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const bytes = await handle.readFile();
    const value = JSON.parse(bytes.toString("utf8"));
    if (!bytes.equals(Buffer.from(`${canonicalAuthorityJournalJson(value)}\n`, "utf8"))) {
      throw new Error("EXP0001A_AUTHORITY_JOURNAL_ENTRY_NOT_CANONICAL");
    }
    return value;
  } finally {
    await handle.close();
  }
}

function verifyEntry(value, expectedSequence, priorEntryDigest) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || value.schemaVersion !== EXP0001A_AUTHORITY_JOURNAL_VERSION
      || value.protocolId !== "EXP-0001A"
      || value.sequence !== expectedSequence
      || value.priorEntryDigest !== priorEntryDigest
      || !["coordinator_checkpoint", "runtime_preflight", "coordinator_action_result", "usage_reset_probe", "completion_draft", "completion_attestation"]
        .includes(value.kind)
      || typeof value.recordedAt !== "string" || !Number.isFinite(Date.parse(value.recordedAt))
      || !DIGEST.test(value.payloadDigest) || !DIGEST.test(value.entryDigest)
      || value.payload === undefined) {
    throw new Error(`EXP0001A_AUTHORITY_JOURNAL_ENTRY_SCHEMA_INVALID:${expectedSequence}`);
  }
  if (digestCanonical(value.payload) !== value.payloadDigest) {
    throw new Error(`EXP0001A_AUTHORITY_JOURNAL_PAYLOAD_DIGEST_INVALID:${expectedSequence}`);
  }
  const { entryDigest, ...content } = value;
  if (digestCanonical(content) !== entryDigest) {
    throw new Error(`EXP0001A_AUTHORITY_JOURNAL_ENTRY_DIGEST_INVALID:${expectedSequence}`);
  }
  return Object.freeze(value);
}

export async function readExp0001aAuthorityJournal(outputRoot) {
  if (!path.isAbsolute(outputRoot) || path.normalize(outputRoot) !== outputRoot
      || outputRoot === path.parse(outputRoot).root) {
    throw new Error("EXP0001A_AUTHORITY_JOURNAL_OUTPUT_ROOT_INVALID");
  }
  const directory = path.join(outputRoot, EXP0001A_AUTHORITY_JOURNAL_DIRECTORY);
  const exists = await lstat(directory).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (exists === null) return Object.freeze({ directory, entries: Object.freeze([]), journalRoot: null });
  await requirePrivateDirectory(directory);
  const names = (await readdir(directory)).filter((name) => ENTRY_FILE.test(name)).sort();
  const entries = [];
  let priorEntryDigest = null;
  for (const [index, name] of names.entries()) {
    const match = ENTRY_FILE.exec(name);
    if (!match || Number.parseInt(match[1], 10) !== index) {
      throw new Error("EXP0001A_AUTHORITY_JOURNAL_SEQUENCE_GAP");
    }
    const entry = verifyEntry(await readPlainEntry(path.join(directory, name)), index, priorEntryDigest);
    entries.push(entry);
    priorEntryDigest = entry.entryDigest;
  }
  return Object.freeze({ directory, entries: Object.freeze(entries), journalRoot: priorEntryDigest });
}

export async function appendExp0001aAuthorityJournalEntry(input) {
  if (!path.isAbsolute(input.outputRoot) || path.normalize(input.outputRoot) !== input.outputRoot
      || input.outputRoot === path.parse(input.outputRoot).root) {
    throw new Error("EXP0001A_AUTHORITY_JOURNAL_OUTPUT_ROOT_INVALID");
  }
  if (!["coordinator_checkpoint", "runtime_preflight", "coordinator_action_result", "usage_reset_probe", "completion_draft", "completion_attestation"]
    .includes(input.kind)) {
    throw new Error("EXP0001A_AUTHORITY_JOURNAL_KIND_INVALID");
  }
  if (typeof input.recordedAt !== "string" || !Number.isFinite(Date.parse(input.recordedAt))) {
    throw new Error("EXP0001A_AUTHORITY_JOURNAL_TIME_INVALID");
  }
  await mkdir(input.outputRoot, { recursive: true, mode: 0o700 });
  await requirePrivateDirectory(input.outputRoot);
  const directory = path.join(input.outputRoot, EXP0001A_AUTHORITY_JOURNAL_DIRECTORY);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await requirePrivateDirectory(directory);
  const lock = await acquireAppendLock(directory);
  try {
    await cleanupOrphanEntryTemporaries(directory);
    const retained = await readExp0001aAuthorityJournal(input.outputRoot);
    const payloadDigest = digestCanonical(input.payload);
    const existing = retained.entries.find((entry) => entry.kind === input.kind
      && entry.payloadDigest === payloadDigest);
    if (existing !== undefined) {
      return Object.freeze({ alreadyRetained: true, entry: existing, journalRoot: retained.journalRoot });
    }
    const content = {
      schemaVersion: EXP0001A_AUTHORITY_JOURNAL_VERSION,
      protocolId: "EXP-0001A",
      sequence: retained.entries.length,
      priorEntryDigest: retained.journalRoot,
      kind: input.kind,
      recordedAt: input.recordedAt,
      payloadDigest,
      payload: input.payload,
    };
    const entry = Object.freeze({ ...content, entryDigest: digestCanonical(content) });
    verifyEntry(entry, content.sequence, content.priorEntryDigest);
    const filePath = path.join(directory, `entry-${String(content.sequence).padStart(6, "0")}.json`);
    const bytes = Buffer.from(`${canonicalAuthorityJournalJson(entry)}\n`, "utf8");
    await publishEntryNoClobber(directory, filePath, entry, bytes);
    const readback = verifyEntry(await readPlainEntry(filePath), content.sequence, content.priorEntryDigest);
    if (canonicalAuthorityJournalJson(readback) !== canonicalAuthorityJournalJson(entry)) {
      throw new Error("EXP0001A_AUTHORITY_JOURNAL_READBACK_DRIFT");
    }
    return Object.freeze({ alreadyRetained: false, entry: readback, journalRoot: readback.entryDigest });
  } finally {
    await releaseAppendLock(directory, lock);
  }
}
