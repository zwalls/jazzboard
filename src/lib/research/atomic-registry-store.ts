import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";

import { canonicalJson } from "./provenance-crypto";

export type AtomicRegistryStoreOptions<T> = {
  filePath: string;
  validate: (input: unknown) => T;
  identity: (value: T) => string;
  now?: () => string;
};

const atomicRegistryStoreBrand: unique symbol = Symbol("atomic-registry-store");

export type AtomicRegistryStore<T> = {
  readonly [atomicRegistryStoreBrand]: true;
  initialize: (initialValue: unknown) => Promise<T>;
  read: () => Promise<T>;
  persist: (nextValue: unknown, expectedPreviousIdentity: string) => Promise<T>;
};

const SAFE_IDENTITY = /^(?:sha256:)?[a-f0-9]{64}$/;

function serialized(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), "utf8");
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function parseBytes(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function assertIdentity(value: string, label: string): string {
  if (!SAFE_IDENTITY.test(value)) throw new Error(`${label} must be a SHA-256 identity.`);
  return value;
}

async function readNoFollow(filePath: string): Promise<Buffer> {
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Registry path is not a regular file.");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function durableWriteNew(filePath: string, bytes: Buffer): Promise<void> {
  const handle = await open(filePath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function createAtomicRegistryStore<T>(options: AtomicRegistryStoreOptions<T>): AtomicRegistryStore<T> {
  if (!path.isAbsolute(options.filePath)) throw new Error("Registry file path must be absolute.");
  const directory = path.dirname(options.filePath);
  const lockPath = `${options.filePath}.lock`;
  const journalDirectory = `${options.filePath}.journal`;
  const now = options.now ?? (() => new Date().toISOString());

  const validate = (input: unknown): T => {
    const value = options.validate(input);
    assertIdentity(options.identity(value), "Registry identity");
    return value;
  };

  type JournalRecord = {
    schemaVersion: 1;
    sequence: number;
    previousIdentity: string | null;
    identity: string;
    value: T;
    recordDigest: string;
  };

  const journalFileName = (record: JournalRecord) => (
    `${record.sequence.toString().padStart(8, "0")}-${record.identity.replace(/^sha256:/, "")}.json`
  );

  const journalProjection = (record: JournalRecord) => ({
    schemaVersion: record.schemaVersion,
    sequence: record.sequence,
    previousIdentity: record.previousIdentity,
    identity: record.identity,
    value: record.value,
  });

  const loadJournal = async (): Promise<JournalRecord[] | null> => {
    let directoryStat;
    try {
      directoryStat = await lstat(journalDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error("Registry journal path is not a plain directory.");
    }
    const names = (await readdir(journalDirectory)).sort();
    if (names.length === 0 || names.some((name) => !/^\d{8}-[a-f0-9]{64}\.json$/.test(name))) {
      throw new Error("Registry journal is empty or contains unexpected entries.");
    }
    const records: JournalRecord[] = [];
    for (const name of names) {
      const raw = parseBytes(await readNoFollow(path.join(journalDirectory, name)), `Registry journal ${name}`) as Partial<JournalRecord>;
      if (raw.schemaVersion !== 1 || !Number.isSafeInteger(raw.sequence) || (raw.sequence as number) < 0
          || (raw.previousIdentity !== null && typeof raw.previousIdentity !== "string")
          || typeof raw.identity !== "string" || typeof raw.recordDigest !== "string" || raw.value === undefined) {
        throw new Error("Registry journal entry has an invalid shape.");
      }
      const value = validate(raw.value);
      const record: JournalRecord = {
        schemaVersion: 1,
        sequence: raw.sequence as number,
        previousIdentity: raw.previousIdentity as string | null,
        identity: assertIdentity(raw.identity, "Journal identity"),
        value,
        recordDigest: assertIdentity(raw.recordDigest, "Journal record digest"),
      };
      const previous = records.at(-1);
      if (record.sequence !== records.length
          || record.previousIdentity !== (previous?.identity ?? null)
          || record.identity !== options.identity(value)
          || record.recordDigest !== sha256(canonicalJson(journalProjection(record)))
          || journalFileName(record) !== name) {
        throw new Error("Registry journal order, identity, or hash chain is invalid.");
      }
      records.push(record);
    }
    return records;
  };

  const appendJournal = async (value: T, previousIdentity: string | null): Promise<JournalRecord> => {
    const existing = await loadJournal();
    if ((existing?.at(-1)?.identity ?? null) !== previousIdentity) {
      throw new Error("Registry journal changed before append.");
    }
    if (!existing) {
      await mkdir(journalDirectory, { recursive: false, mode: 0o700 });
      await syncDirectory(directory);
    }
    const content = {
      schemaVersion: 1 as const,
      sequence: existing?.length ?? 0,
      previousIdentity,
      identity: options.identity(value),
      value,
    };
    const record: JournalRecord = { ...content, recordDigest: sha256(canonicalJson(content)) };
    await durableWriteNew(path.join(journalDirectory, journalFileName(record)), serialized(record));
    await syncDirectory(journalDirectory);
    return record;
  };

  const readSnapshot = async (): Promise<T> => validate(parseBytes(await readNoFollow(options.filePath), "Registry"));

  const read = async (): Promise<T> => {
    const records = await loadJournal();
    if (!records) throw Object.assign(new Error("Registry journal is missing."), { code: "ENOENT" });
    const latest = records.at(-1)!;
    const snapshot = await readSnapshot();
    const snapshotIdentity = options.identity(snapshot);
    const priorIdentity = records.at(-2)?.identity ?? null;
    if (snapshotIdentity !== latest.identity && snapshotIdentity !== priorIdentity) {
      throw new Error("Registry snapshot is not the journal head or its single crash-recoverable predecessor.");
    }
    return latest.value;
  };

  const withLock = async <R>(operation: () => Promise<R>): Promise<R> => {
    let lockHandle;
    try {
      lockHandle = await open(lockPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Registry lock already exists; refusing concurrent or uncertain execution: ${lockPath}`);
      }
      throw error;
    }
    try {
      await lockHandle.writeFile(serialized({ schemaVersion: 1, acquiredAt: now(), pid: process.pid }));
      await lockHandle.sync();
      return await operation();
    } finally {
      await lockHandle.close().catch(() => {});
      await unlink(lockPath).catch(() => {});
      await syncDirectory(directory).catch(() => {});
    }
  };

  const replaceUnderLock = async (value: T): Promise<T> => {
    const tempPath = `${options.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await durableWriteNew(tempPath, serialized(value));
      await rename(tempPath, options.filePath);
      await syncDirectory(directory);
    } finally {
      await unlink(tempPath).catch(() => {});
    }
    const retained = await readSnapshot();
    if (options.identity(retained) !== options.identity(value)) {
      throw new Error("Durable registry readback identity differs from the value written.");
    }
    return retained;
  };

  return {
    [atomicRegistryStoreBrand]: true,
    read,
    initialize: async (initialValue) => {
      const initial = validate(initialValue);
      return withLock(async () => {
        const journal = await loadJournal();
        if (journal) {
          if (journal[0]?.identity !== options.identity(initial)) {
            throw new Error("Registry journal genesis differs from the requested initial registry.");
          }
          const latest = journal.at(-1)!;
          let snapshot: T | null = null;
          try {
            snapshot = await readSnapshot();
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
          const snapshotIdentity = snapshot ? options.identity(snapshot) : null;
          const priorIdentity = journal.at(-2)?.identity ?? null;
          if (snapshotIdentity !== latest.identity && snapshotIdentity !== priorIdentity) {
            throw new Error("Existing registry snapshot cannot be reconciled to the append-only journal.");
          }
          if (snapshotIdentity !== latest.identity) await replaceUnderLock(latest.value);
          return latest.value;
        }
        let existing: T | null = null;
        try {
          existing = await readSnapshot();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (existing && options.identity(existing) !== options.identity(initial)) {
          throw new Error("Unjournaled existing registry differs from the requested initial registry.");
        }
        await appendJournal(initial, null);
        if (!existing) await durableWriteNew(options.filePath, serialized(initial));
        await syncDirectory(directory);
        return read();
      });
    },
    persist: async (nextValue, expectedPreviousIdentity) => {
      assertIdentity(expectedPreviousIdentity, "Expected prior registry identity");
      const next = validate(nextValue);
      return withLock(async () => {
        const current = await read();
        if (options.identity(current) !== expectedPreviousIdentity) {
          throw new Error("Registry changed since the caller's last durable snapshot.");
        }
        if (options.identity(next) === expectedPreviousIdentity) {
          throw new Error("Refusing a redundant registry persistence without a new identity.");
        }
        await appendJournal(next, expectedPreviousIdentity);
        return replaceUnderLock(next);
      });
    },
  };
}
