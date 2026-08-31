// @vitest-environment node

import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { hashCanonicalJson, type JsonValue } from "../../src/lib/research/provenance-crypto";
// @ts-expect-error committed ESM transaction boundary intentionally has no declaration file
import { persistExp0001aCoordinatorMutation, recoverExp0001aCoordinatorMutation } from "./exp0001a-coordinator-transaction.mjs";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));
const digest = (value: unknown) => hashCanonicalJson(value as JsonValue);
const transactionDirectory = "coordinator-state-transactions";
const transactionLockFile = ".coordinator-state-transaction.lock";
const transactionRecoveryGuard = ".coordinator-state-transaction.lock.recovery";
const deadPid = 2_147_483_647;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settled) => { resolve = settled; });
  return { promise, resolve };
}

async function retainSyntheticLock(filePath: string, pid: number, ownerToken: string) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, `${JSON.stringify({
    pid,
    ownerToken,
    createdAt: "2026-08-31T04:59:00.000Z",
  })}\n`, { mode: 0o600 });
}

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "exp0001a-state-transaction-"));
  roots.push(root);
  const files = {
    provisioningCoordinatorState: path.join(root, "provisioning.json"),
    coordinatorJournal: path.join(root, "coordinator.json"),
    accountingLedger: path.join(root, "accounting.json"),
    schedulerState: path.join(root, "scheduler.json"),
  };
  const priorScheduler = { window: 0, state: "prior" };
  const nextScheduler = { window: 0, state: "next" };
  const priorStateContent = { scheduler: priorScheduler, reservations: [] };
  const priorState = { ...priorStateContent, stateDigest: digest(priorStateContent) };
  const nextStateContent = { scheduler: nextScheduler, reservations: [{ assignmentId: "assignment-1" }] };
  const nextState = { ...nextStateContent, stateDigest: digest(nextStateContent) };
  const priorJournalContent = { priorJournalDigest: null, provisioningStateDigest: priorState.stateDigest,
    accounting: [{ state: "prior" }] };
  const priorJournal = { ...priorJournalContent, journalDigest: digest(priorJournalContent) };
  const nextJournalContent = { priorJournalDigest: priorJournal.journalDigest,
    provisioningStateDigest: nextState.stateDigest, accounting: [{ state: "next" }] };
  const nextJournal = { ...nextJournalContent, journalDigest: digest(nextJournalContent) };
  const registryRecords = [priorState, nextState].map((value, sequence, values) => {
    const content = { schemaVersion: 1, sequence,
      previousIdentity: sequence === 0 ? null : values[sequence - 1]!.stateDigest,
      identity: value.stateDigest, value };
    return { ...content, recordDigest: digest(content) };
  });
  const stagingPath = path.join(root, "staging.json");
  await mkdir(`${stagingPath}.journal`, { recursive: true, mode: 0o700 });
  for (const record of registryRecords) {
    const name = `${record.sequence.toString().padStart(8, "0")}-${record.identity.slice(7)}.json`;
    await writeFile(path.join(`${stagingPath}.journal`, name), JSON.stringify(record), { mode: 0o600 });
  }
  for (const [file, value] of [
    [files.provisioningCoordinatorState, priorState], [files.coordinatorJournal, priorJournal],
    [files.accountingLedger, priorJournal.accounting], [files.schedulerState, priorScheduler],
  ] as const) await writeFile(file, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  const config = { outputRoot: path.join(root, "output"), files };
  const runtime = {
    exp0001aCodexCoordinatorJournalSchema: { parse: (value: unknown) => value },
    exp0001aCodexSchedulerStateSchema: { parse: (value: unknown) => value },
    deriveExp0001aCodexAccountingLedgerFromCoordinatorJournal: (journal: typeof nextJournal) => journal.accounting,
  };
  const mutation = { provisioningState: nextState, coordinatorJournal: nextJournal,
    retainedEvidenceDigest: digest("evidence") };
  return { root, config, runtime, mutation, stagingPath, priorState, priorJournal, priorScheduler };
}

describe("EXP-0001A coordinator canonical transaction", () => {
  for (const failureBoundary of ["provisioning", "journal", "accounting", "scheduler"] as const) {
    it(`repairs an interrupted ${failureBoundary} projection from the immutable transaction`, async () => {
      const value = await fixture();
      let failed = false;
      const writeProjection = async (filePath: string, next: unknown, label: string) => {
        if (label === failureBoundary && !failed) {
          failed = true;
          throw new Error(`synthetic-crash-${label}`);
        }
        await writeFile(filePath, `${JSON.stringify(next)}\n`);
      };
      await expect(persistExp0001aCoordinatorMutation(value.runtime, value.config, value.mutation, {
        actionDigest: digest("action"), retainedAt: "2026-08-31T05:00:00.000Z",
        stagingProvisioningPath: value.stagingPath, writeProjection,
      })).rejects.toThrow(`synthetic-crash-${failureBoundary}`);

      const recovered = await recoverExp0001aCoordinatorMutation(value.runtime, value.config);
      expect(recovered).toMatchObject({ recovered: true,
        coordinatorJournalDigest: value.mutation.coordinatorJournal.journalDigest });
      const retained = await Promise.all(Object.values(value.config.files).map(async (file) =>
        JSON.parse((await readFile(file, "utf8")))));
      expect(retained).toEqual([
        value.mutation.provisioningState,
        value.mutation.coordinatorJournal,
        value.mutation.coordinatorJournal.accounting,
        value.mutation.provisioningState.scheduler,
      ]);
    });
  }

  it("rejects a sibling transition at prior-head CAS before it can fork the run", async () => {
    const value = await fixture();
    await persistExp0001aCoordinatorMutation(value.runtime, value.config, value.mutation, {
      actionDigest: digest("action-one"), retainedAt: "2026-08-31T05:00:00.000Z",
      stagingProvisioningPath: value.stagingPath,
    });
    const forkJournalContent = { ...value.mutation.coordinatorJournal,
      journalDigest: undefined, accounting: [{ state: "fork" }] };
    delete forkJournalContent.journalDigest;
    const forkJournal = { ...forkJournalContent, journalDigest: digest(forkJournalContent) };
    await expect(persistExp0001aCoordinatorMutation(value.runtime, value.config, {
      ...value.mutation, coordinatorJournal: forkJournal,
    }, {
      actionDigest: digest("action-two"), retainedAt: "2026-08-31T05:00:01.000Z",
      stagingProvisioningPath: value.stagingPath,
    })).rejects.toThrow(/PRIOR_HEAD_CAS_FAILED/);
    await expect(recoverExp0001aCoordinatorMutation(value.runtime, value.config)).resolves.toMatchObject({
      recovered: true,
      coordinatorJournalDigest: value.mutation.coordinatorJournal.journalDigest,
    });
  });

  it("serializes concurrent identical replays into one immutable state edge", async () => {
    const value = await fixture();
    const projectionGate = deferred();
    const options = {
      actionDigest: digest("concurrent-action"),
      retainedAt: "2026-08-31T05:00:00.000Z",
      stagingProvisioningPath: value.stagingPath,
      writeProjection: async (filePath: string, next: unknown) => {
        await projectionGate.promise;
        await writeFile(filePath, `${JSON.stringify(next)}\n`);
      },
    };
    const calls = [
      persistExp0001aCoordinatorMutation(value.runtime, value.config, value.mutation, options),
      persistExp0001aCoordinatorMutation(value.runtime, value.config, value.mutation, options),
    ];
    const firstFailure = await Promise.race(calls.map(async (call) => {
      try { await call; return null; } catch (error) { return error; }
    }));
    expect(firstFailure).toMatchObject({ message: "EXP0001A_COORDINATOR_TRANSACTION_IN_PROGRESS" });
    projectionGate.resolve();
    const settled = await Promise.allSettled(calls);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((settled.find((result) => result.status === "rejected") as PromiseRejectedResult).reason)
      .toMatchObject({ message: "EXP0001A_COORDINATOR_TRANSACTION_IN_PROGRESS" });
    const transactionFiles = (await readdir(path.join(value.config.outputRoot, "coordinator-state-transactions")))
      .filter((name) => /^[a-f0-9]{64}\.json$/.test(name));
    expect(transactionFiles).toHaveLength(1);
    await expect(persistExp0001aCoordinatorMutation(
      value.runtime, value.config, value.mutation, options,
    )).resolves.toMatchObject({
      coordinatorJournalDigest: value.mutation.coordinatorJournal.journalDigest,
    });
  });

  it("serializes concurrent stale takeover into exactly one owner", async () => {
    const value = await fixture();
    const root = path.join(value.config.outputRoot, transactionDirectory);
    const lockPath = path.join(root, transactionLockFile);
    await retainSyntheticLock(lockPath, deadPid, "stale-owner");
    const projectionGate = deferred();
    const ownerAcquired = deferred();
    const options = {
      actionDigest: digest("stale-concurrent-action"),
      retainedAt: "2026-08-31T05:00:00.000Z",
      stagingProvisioningPath: value.stagingPath,
      writeProjection: async (filePath: string, next: unknown) => {
        ownerAcquired.resolve();
        await projectionGate.promise;
        await writeFile(filePath, `${JSON.stringify(next)}\n`);
      },
    };
    const calls = [
      persistExp0001aCoordinatorMutation(value.runtime, value.config, value.mutation, options),
      persistExp0001aCoordinatorMutation(value.runtime, value.config, value.mutation, options),
    ];
    const firstFailure = await Promise.race(calls.map(async (call) => {
      try { await call; return null; } catch (error) { return error; }
    }));
    expect(firstFailure).toMatchObject({ message: "EXP0001A_COORDINATOR_TRANSACTION_IN_PROGRESS" });
    await ownerAcquired.promise;
    const retainedOwner = JSON.parse(await readFile(lockPath, "utf8"));
    expect(retainedOwner).toMatchObject({ pid: process.pid });
    expect(retainedOwner.ownerToken).not.toBe("stale-owner");
    projectionGate.resolve();
    const settled = await Promise.allSettled(calls);
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("fails closed while a stale recovery guard exists", async () => {
    const value = await fixture();
    const root = path.join(value.config.outputRoot, transactionDirectory);
    const guardPath = path.join(root, transactionRecoveryGuard);
    await retainSyntheticLock(guardPath, deadPid, "abandoned-recovery");

    await expect(persistExp0001aCoordinatorMutation(value.runtime, value.config, value.mutation, {
      actionDigest: digest("guarded-action"),
      retainedAt: "2026-08-31T05:00:00.000Z",
      stagingProvisioningPath: value.stagingPath,
    })).rejects.toThrow("EXP0001A_COORDINATOR_TRANSACTION_IN_PROGRESS");
    await expect(readFile(guardPath, "utf8")).resolves.toContain("abandoned-recovery");
    await expect(readFile(path.join(root, transactionLockFile), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not unlink another owner's replacement when releasing", async () => {
    const value = await fixture();
    const root = path.join(value.config.outputRoot, transactionDirectory);
    const lockPath = path.join(root, transactionLockFile);
    let replaced = false;
    const replacement = {
      pid: process.pid,
      ownerToken: "replacement-owner",
      createdAt: "2026-08-31T05:00:01.000Z",
    };
    await persistExp0001aCoordinatorMutation(value.runtime, value.config, value.mutation, {
      actionDigest: digest("replacement-action"),
      retainedAt: "2026-08-31T05:00:00.000Z",
      stagingProvisioningPath: value.stagingPath,
      writeProjection: async (filePath: string, next: unknown) => {
        if (!replaced) {
          replaced = true;
          await unlink(lockPath);
          await writeFile(lockPath, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
        }
        await writeFile(filePath, `${JSON.stringify(next)}\n`);
      },
    });

    await expect(readFile(lockPath, "utf8")).resolves.toBe(`${JSON.stringify(replacement)}\n`);
  });
});
