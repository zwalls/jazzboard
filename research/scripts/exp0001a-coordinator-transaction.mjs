import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { cp, link, lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { canonicalJson, sha256Canonical } from "./exp0001a-codex-launch-readiness.mjs";

export const EXP0001A_COORDINATOR_TRANSACTION_VERSION =
  "exp-0001a-coordinator-state-transaction/v1";
const TRANSACTION_DIRECTORY = "coordinator-state-transactions";
const TRANSACTION_LOCK_FILE = ".coordinator-state-transaction.lock";
const TRANSACTION_LOCK_RECOVERY_GUARD = ".coordinator-state-transaction.lock.recovery";
let stagingOrdinal = 0;

async function readPlainBytes(filePath) {
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`EXP-0001A state must be a plain file: ${filePath}`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function readPlainJson(filePath) {
  return JSON.parse((await readPlainBytes(filePath)).toString("utf8"));
}

async function syncDirectory(directory) {
  const handle = await open(directory, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function readLockOwnership(filePath) {
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile()) throw new Error("lock is not a plain file");
    const retained = JSON.parse((await handle.readFile()).toString("utf8"));
    if (!Number.isInteger(retained?.pid) || retained.pid <= 0
        || typeof retained.ownerToken !== "string" || retained.ownerToken.length === 0
        || typeof retained.createdAt !== "string") {
      throw new Error("lock owner is invalid");
    }
    return Object.freeze({
      pid: retained.pid,
      ownerToken: retained.ownerToken,
      createdAt: retained.createdAt,
      dev: stat.dev,
      ino: stat.ino,
    });
  } finally {
    await handle.close();
  }
}

function sameLockOwnership(left, right) {
  return left.pid === right.pid && left.ownerToken === right.ownerToken
    && left.dev === right.dev && left.ino === right.ino;
}

function lockOwnerIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

async function createOwnedLock(root, filePath) {
  const owner = Object.freeze({
    pid: process.pid,
    ownerToken: randomUUID(),
    createdAt: new Date().toISOString(),
  });
  const handle = await open(filePath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(`${canonicalJson(owner)}\n`);
    await handle.sync();
    const stat = await handle.stat({ bigint: true });
    await syncDirectory(root);
    return Object.freeze({ ...owner, dev: stat.dev, ino: stat.ino });
  } finally {
    await handle.close();
  }
}

async function releaseOwnedLock(root, filePath, ownership) {
  let retained;
  try {
    retained = await readLockOwnership(filePath);
  } catch {
    return false;
  }
  if (!sameLockOwnership(retained, ownership)) return false;
  await unlink(filePath);
  await syncDirectory(root);
  return true;
}

async function acquireTransactionLock(root) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lockPath = path.join(root, TRANSACTION_LOCK_FILE);
  const recoveryGuardPath = path.join(root, TRANSACTION_LOCK_RECOVERY_GUARD);
  let recoveryGuard;
  try {
    recoveryGuard = await createOwnedLock(root, recoveryGuardPath);
  } catch (error) {
    if (error?.code === "EEXIST") {
      // A recovery sentinel is deliberately never recovered recursively. Its
      // presence makes both ordinary acquisition and competing recovery fail closed.
      throw new Error("EXP0001A_COORDINATOR_TRANSACTION_IN_PROGRESS");
    }
    throw error;
  }

  let ownership;
  try {
    try {
      ownership = await createOwnedLock(root, lockPath);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let staleOwnership;
      try {
        staleOwnership = await readLockOwnership(lockPath);
      } catch {
        throw new Error("EXP0001A_COORDINATOR_TRANSACTION_LOCK_INVALID");
      }
      if (lockOwnerIsAlive(staleOwnership.pid)) {
        throw new Error("EXP0001A_COORDINATOR_TRANSACTION_IN_PROGRESS");
      }

      let confirmedOwnership;
      try {
        confirmedOwnership = await readLockOwnership(lockPath);
      } catch {
        throw new Error("EXP0001A_COORDINATOR_TRANSACTION_LOCK_RECOVERY_FAILED");
      }
      if (!sameLockOwnership(staleOwnership, confirmedOwnership)
          || lockOwnerIsAlive(confirmedOwnership.pid)) {
        throw new Error("EXP0001A_COORDINATOR_TRANSACTION_LOCK_RECOVERY_FAILED");
      }
      await unlink(lockPath);
      await syncDirectory(root);
      try {
        ownership = await createOwnedLock(root, lockPath);
      } catch (error) {
        if (error?.code === "EEXIST") {
          throw new Error("EXP0001A_COORDINATOR_TRANSACTION_LOCK_RECOVERY_FAILED");
        }
        throw error;
      }
    }
  } finally {
    await releaseOwnedLock(root, recoveryGuardPath, recoveryGuard);
  }

  return async () => {
    await releaseOwnedLock(root, lockPath, ownership);
  };
}

async function retainExclusiveOrExact(filePath, bytes) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(path.dirname(filePath),
    `.publish-${process.pid}-${Date.now()}-${stagingOrdinal++}.tmp`);
  try {
    const handle = await open(temporaryPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await link(temporaryPath, filePath);
    await syncDirectory(path.dirname(filePath));
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
  if (!(await readPlainBytes(filePath)).equals(bytes)) {
    throw new Error("EXP0001A_COORDINATOR_TRANSACTION_REPLAY_DRIFT");
  }
}

async function retainAtomicJson(filePath, value) {
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`EXP-0001A state must be a plain file: ${filePath}`);
  }
  const temporaryPath = path.join(path.dirname(filePath),
    `.coordinator-transaction-${process.pid}-${Date.now()}-${stagingOrdinal++}.tmp`);
  const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
  const handle = await open(temporaryPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    metadata.mode & 0o777);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try {
    await rename(temporaryPath, filePath);
    await syncDirectory(path.dirname(filePath));
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  if (!(await readPlainBytes(filePath)).equals(bytes)) {
    throw new Error("EXP0001A_COORDINATOR_TRANSACTION_PROJECTION_READBACK_MISMATCH");
  }
}

async function readProvisioningRegistryRecords(journalPath) {
  const names = await readdir(journalPath).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  if (names.some((name) => !/^\d{8}-[a-f0-9]{64}\.json$/.test(name))) {
    throw new Error("EXP0001A_PROVISIONING_REGISTRY_JOURNAL_FILE_INVALID");
  }
  return Promise.all(names.sort().map((name) => readPlainJson(path.join(journalPath, name))));
}

function transactionContent(runtime, mutation, actionDigest, retainedAt, provisioningRegistryRecords) {
  const ledger = runtime.deriveExp0001aCodexAccountingLedgerFromCoordinatorJournal(
    mutation.coordinatorJournal,
  );
  if (mutation.coordinatorJournal.provisioningStateDigest !== mutation.provisioningState.stateDigest) {
    throw new Error("EXP0001A_COORDINATOR_TRANSACTION_CROSS_STATE_BINDING_INVALID");
  }
  return Object.freeze({
    schemaVersion: EXP0001A_COORDINATOR_TRANSACTION_VERSION,
    protocolId: "EXP-0001A",
    actionDigest,
    retainedAt,
    priorCoordinatorJournalDigest: mutation.coordinatorJournal.priorJournalDigest,
    nextCoordinatorJournalDigest: mutation.coordinatorJournal.journalDigest,
    provisioningState: mutation.provisioningState,
    provisioningRegistryRecords,
    coordinatorJournal: mutation.coordinatorJournal,
    accountingLedger: ledger,
    schedulerState: mutation.provisioningState.scheduler,
    projectionDigests: Object.freeze({
      provisioningStateDigest: mutation.provisioningState.stateDigest,
      coordinatorJournalDigest: mutation.coordinatorJournal.journalDigest,
      accountingLedgerDigest: sha256Canonical(ledger),
      schedulerStateDigest: sha256Canonical(mutation.provisioningState.scheduler),
    }),
  });
}

export function verifyExp0001aCoordinatorTransaction(runtime, input) {
  if (input?.schemaVersion !== EXP0001A_COORDINATOR_TRANSACTION_VERSION
      || input.protocolId !== "EXP-0001A" || typeof input.actionDigest !== "string"
      || typeof input.transactionDigest !== "string") {
    throw new Error("EXP0001A_COORDINATOR_TRANSACTION_SHAPE_INVALID");
  }
  const { transactionDigest, ...content } = input;
  if (sha256Canonical(content) !== transactionDigest
      || input.nextCoordinatorJournalDigest !== input.coordinatorJournal?.journalDigest
      || input.priorCoordinatorJournalDigest !== input.coordinatorJournal?.priorJournalDigest
      || input.provisioningState?.stateDigest !== input.coordinatorJournal?.provisioningStateDigest
      || canonicalJson(input.schedulerState) !== canonicalJson(input.provisioningState?.scheduler)) {
    throw new Error("EXP0001A_COORDINATOR_TRANSACTION_DIGEST_OR_BINDING_INVALID");
  }
  const journal = runtime.exp0001aCodexCoordinatorJournalSchema.parse(input.coordinatorJournal);
  const ledger = runtime.deriveExp0001aCodexAccountingLedgerFromCoordinatorJournal(journal);
  const scheduler = runtime.exp0001aCodexSchedulerStateSchema.parse(input.schedulerState);
  if (!Array.isArray(input.provisioningRegistryRecords) || input.provisioningRegistryRecords.length === 0) {
    throw new Error("EXP0001A_COORDINATOR_TRANSACTION_PROVISIONING_JOURNAL_MISSING");
  }
  input.provisioningRegistryRecords.forEach((record, index) => {
    const projection = { schemaVersion: record?.schemaVersion, sequence: record?.sequence,
      previousIdentity: record?.previousIdentity, identity: record?.identity, value: record?.value };
    if (record?.schemaVersion !== 1 || record.sequence !== index
        || record.previousIdentity !== (input.provisioningRegistryRecords[index - 1]?.identity ?? null)
        || record.identity !== record.value?.stateDigest
        || record.recordDigest !== sha256Canonical(projection)) {
      throw new Error("EXP0001A_COORDINATOR_TRANSACTION_PROVISIONING_JOURNAL_INVALID");
    }
  });
  if (input.provisioningRegistryRecords.at(-1)?.identity !== input.provisioningState.stateDigest
      || canonicalJson(ledger) !== canonicalJson(input.accountingLedger)
      || canonicalJson(scheduler) !== canonicalJson(input.provisioningState.scheduler)
      || input.projectionDigests?.provisioningStateDigest !== input.provisioningState.stateDigest
      || input.projectionDigests?.coordinatorJournalDigest !== journal.journalDigest
      || input.projectionDigests?.accountingLedgerDigest !== sha256Canonical(ledger)
      || input.projectionDigests?.schedulerStateDigest !== sha256Canonical(scheduler)) {
    throw new Error("EXP0001A_COORDINATOR_TRANSACTION_PROJECTION_INVALID");
  }
  return Object.freeze(input);
}

async function applyTransaction(config, transaction, writeProjection = retainAtomicJson) {
  const registryRoot = `${config.files.provisioningCoordinatorState}.journal`;
  await mkdir(registryRoot, { recursive: true, mode: 0o700 });
  for (const record of transaction.provisioningRegistryRecords) {
    const name = `${record.sequence.toString().padStart(8, "0")}-${record.identity.replace(/^sha256:/, "")}.json`;
    await retainExclusiveOrExact(path.join(registryRoot, name), Buffer.from(canonicalJson(record), "utf8"));
  }
  await syncDirectory(registryRoot);
  await writeProjection(config.files.provisioningCoordinatorState, transaction.provisioningState, "provisioning");
  await writeProjection(config.files.coordinatorJournal, transaction.coordinatorJournal, "journal");
  await writeProjection(config.files.accountingLedger, transaction.accountingLedger, "accounting");
  await writeProjection(config.files.schedulerState, transaction.schedulerState, "scheduler");
  const projections = await Promise.all([
    readPlainJson(config.files.provisioningCoordinatorState), readPlainJson(config.files.coordinatorJournal),
    readPlainJson(config.files.accountingLedger), readPlainJson(config.files.schedulerState),
  ]);
  if (canonicalJson(projections[0]) !== canonicalJson(transaction.provisioningState)
      || canonicalJson(projections[1]) !== canonicalJson(transaction.coordinatorJournal)
      || canonicalJson(projections[2]) !== canonicalJson(transaction.accountingLedger)
      || canonicalJson(projections[3]) !== canonicalJson(transaction.schedulerState)) {
    throw new Error("EXP0001A_COORDINATOR_TRANSACTION_PROJECTION_READBACK_MISMATCH");
  }
}

async function readVerifiedTransactions(runtime, root) {
  const names = await readdir(root).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  if (names.some((name) => name !== TRANSACTION_LOCK_FILE
      && name !== TRANSACTION_LOCK_RECOVERY_GUARD
      && name !== "staging" && !/^[a-f0-9]{64}\.json$/.test(name))) {
    throw new Error("EXP0001A_COORDINATOR_TRANSACTION_DIRECTORY_ENTRY_INVALID");
  }
  const transactions = [];
  for (const name of names.filter((candidate) => /^[a-f0-9]{64}\.json$/.test(candidate)).sort()) {
    const transaction = verifyExp0001aCoordinatorTransaction(runtime, await readPlainJson(path.join(root, name)));
    if (name !== `${transaction.nextCoordinatorJournalDigest.slice(7)}.json`) {
      throw new Error("EXP0001A_COORDINATOR_TRANSACTION_FILE_NAME_INVALID");
    }
    transactions.push(transaction);
  }
  const byNext = new Map(transactions.map((transaction) => [transaction.nextCoordinatorJournalDigest, transaction]));
  if (byNext.size !== transactions.length) throw new Error("EXP0001A_COORDINATOR_TRANSACTION_DUPLICATE_NEXT_STATE");
  const referenced = new Set(transactions.map((transaction) => transaction.priorCoordinatorJournalDigest).filter(Boolean));
  const heads = transactions.filter((transaction) => !referenced.has(transaction.nextCoordinatorJournalDigest));
  if (transactions.length > 0 && heads.length !== 1) {
    throw new Error("EXP0001A_COORDINATOR_TRANSACTION_FORK_OR_HEAD_INVALID");
  }
  for (const transaction of transactions) {
    if (transactions.filter((candidate) =>
      candidate.priorCoordinatorJournalDigest === transaction.nextCoordinatorJournalDigest).length > 1) {
      throw new Error("EXP0001A_COORDINATOR_TRANSACTION_FORK_OR_HEAD_INVALID");
    }
  }
  return Object.freeze({ transactions, head: heads[0] ?? null });
}

export async function persistExp0001aCoordinatorMutation(runtime, config, mutation, options = {}) {
  const actionDigest = options.actionDigest ?? sha256Canonical({
    kind: "coordinator-mutation", nextCoordinatorJournalDigest: mutation.coordinatorJournal.journalDigest,
  });
  const journalPath = `${options.stagingProvisioningPath ?? config.files.provisioningCoordinatorState}.journal`;
  const content = transactionContent(runtime, mutation, actionDigest,
    options.retainedAt ?? new Date().toISOString(), await readProvisioningRegistryRecords(journalPath));
  const transaction = Object.freeze({ ...content, transactionDigest: sha256Canonical(content) });
  const root = path.join(config.outputRoot, TRANSACTION_DIRECTORY);
  const releaseLock = await acquireTransactionLock(root);
  try {
    const retained = await readVerifiedTransactions(runtime, root);
    const existingExact = retained.transactions.find((candidate) =>
      candidate.nextCoordinatorJournalDigest === transaction.nextCoordinatorJournalDigest);
    if (existingExact !== undefined) {
      if (canonicalJson(existingExact) !== canonicalJson(transaction)) {
        throw new Error("EXP0001A_COORDINATOR_TRANSACTION_REPLAY_DRIFT");
      }
      await applyTransaction(config, existingExact, options.writeProjection);
      return Object.freeze({ ...existingExact.projectionDigests, transactionDigest: existingExact.transactionDigest,
        transactionPath: path.join(root, `${existingExact.nextCoordinatorJournalDigest.slice(7)}.json`) });
    }
    const expectedPrior = retained.head === null
      ? (await readPlainJson(config.files.coordinatorJournal)).journalDigest
      : retained.head.nextCoordinatorJournalDigest;
    if (transaction.priorCoordinatorJournalDigest !== expectedPrior) {
      throw new Error("EXP0001A_COORDINATOR_TRANSACTION_PRIOR_HEAD_CAS_FAILED");
    }
    const transactionPath = path.join(root, `${transaction.nextCoordinatorJournalDigest.slice(7)}.json`);
    await retainExclusiveOrExact(transactionPath, Buffer.from(`${canonicalJson(transaction)}\n`, "utf8"));
    verifyExp0001aCoordinatorTransaction(runtime, transaction);
    await applyTransaction(config, transaction, options.writeProjection);
    return Object.freeze({ ...transaction.projectionDigests, transactionDigest: transaction.transactionDigest,
      transactionPath });
  } finally {
    await releaseLock();
  }
}

export async function recoverExp0001aCoordinatorMutation(runtime, config, options = {}) {
  const root = path.join(config.outputRoot, TRANSACTION_DIRECTORY);
  const exists = await lstat(root).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (exists === null) return Object.freeze({ recovered: false, transactionDigest: null });
  const releaseLock = await acquireTransactionLock(root);
  try {
    const retained = await readVerifiedTransactions(runtime, root);
    if (retained.head === null) return Object.freeze({ recovered: false, transactionDigest: null });
    await applyTransaction(config, retained.head, options.writeProjection);
    return Object.freeze({ recovered: true, transactionDigest: retained.head.transactionDigest,
      coordinatorJournalDigest: retained.head.nextCoordinatorJournalDigest });
  } finally {
    await releaseLock();
  }
}

export async function createExp0001aStagedProvisioningCoordinator(runtime, config, provisioningState, actionDigest) {
  const root = path.join(config.outputRoot, TRANSACTION_DIRECTORY, "staging");
  const stagingPath = path.join(root,
    `${actionDigest.slice(7)}-${process.pid}-${Date.now()}-${stagingOrdinal++}.json`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const sourceJournalPath = `${config.files.provisioningCoordinatorState}.journal`;
  const copied = await Promise.all([lstat(config.files.provisioningCoordinatorState), lstat(sourceJournalPath)])
    .then(([snapshot, journal]) => snapshot.isFile() && !snapshot.isSymbolicLink()
      && journal.isDirectory() && !journal.isSymbolicLink())
    .catch((error) => { if (error?.code === "ENOENT") return false; throw error; });
  if (copied) {
    await cp(config.files.provisioningCoordinatorState, stagingPath, { errorOnExist: true });
    await cp(sourceJournalPath, `${stagingPath}.journal`, { recursive: true, errorOnExist: true });
  } else {
    await retainExclusiveOrExact(stagingPath, Buffer.from(`${canonicalJson(provisioningState)}\n`, "utf8"));
  }
  const coordinator = runtime.createExp0001aProvisioningCoordinator({ filePath: stagingPath });
  if (!copied && typeof coordinator.initialize === "function") await coordinator.initialize(provisioningState);
  if (typeof coordinator.read === "function") {
    const retained = await coordinator.read();
    if (retained !== undefined && canonicalJson(retained) !== canonicalJson(provisioningState)) {
      throw new Error("EXP0001A_STAGED_PROVISIONING_PRIOR_STATE_DRIFT");
    }
  }
  return Object.freeze({ coordinator, stagingPath });
}
