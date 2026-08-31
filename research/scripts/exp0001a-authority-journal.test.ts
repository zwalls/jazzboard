// @vitest-environment node

import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const journalModulePath: string = "./exp0001a-authority-journal.mjs";
const {
  appendExp0001aAuthorityJournalEntry,
  canonicalAuthorityJournalJson,
  readExp0001aAuthorityJournal,
} = await import(journalModulePath);

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("EXP-0001A append-only authority journal", () => {
  it("retains a contiguous hash chain and makes exact retries idempotent", async () => {
    const outputRoot = await mkdtemp(path.join(tmpdir(), "exp0001a-authority-journal-"));
    roots.push(outputRoot);
    const checkpoint = await appendExp0001aAuthorityJournalEntry({
      outputRoot,
      kind: "coordinator_checkpoint",
      recordedAt: "2026-08-30T10:00:00.000Z",
      payload: { checkpointId: "checkpoint-1", signed: true },
    });
    const duplicate = await appendExp0001aAuthorityJournalEntry({
      outputRoot,
      kind: "coordinator_checkpoint",
      recordedAt: "2026-08-30T10:00:30.000Z",
      payload: { checkpointId: "checkpoint-1", signed: true },
    });
    expect(duplicate).toMatchObject({ alreadyRetained: true, journalRoot: checkpoint.journalRoot });
    const preflight = await appendExp0001aAuthorityJournalEntry({
      outputRoot,
      kind: "runtime_preflight",
      recordedAt: "2026-08-30T10:00:01.000Z",
      payload: { receiptDigest: "sha256:" + "a".repeat(64), checkpointId: "checkpoint-1" },
    });
    const retained = await readExp0001aAuthorityJournal(outputRoot);
    expect(retained.entries).toHaveLength(2);
    expect(retained.entries[0]).toMatchObject({ sequence: 0, priorEntryDigest: null });
    expect(retained.entries[1]).toMatchObject({ sequence: 1, priorEntryDigest: checkpoint.entry.entryDigest });
    expect(retained.journalRoot).toBe(preflight.entry.entryDigest);
  });

  it("rejects retained byte tampering instead of rebuilding caller evidence", async () => {
    const outputRoot = await mkdtemp(path.join(tmpdir(), "exp0001a-authority-journal-tamper-"));
    roots.push(outputRoot);
    await appendExp0001aAuthorityJournalEntry({
      outputRoot,
      kind: "coordinator_checkpoint",
      recordedAt: "2026-08-30T10:00:00.000Z",
      payload: { checkpointId: "checkpoint-1", signed: true },
    });
    const entryPath = path.join(outputRoot, "authority-journal", "entry-000000.json");
    const entry = JSON.parse(await readFile(entryPath, "utf8"));
    entry.payload = { checkpointId: "checkpoint-forged", signed: true };
    await writeFile(entryPath, `${JSON.stringify(entry)}\n`);
    await expect(readExp0001aAuthorityJournal(outputRoot)).rejects.toThrow(/PAYLOAD_DIGEST_INVALID/);
  });

  it("recovers a killed writer's partial entry temporary and stale partial lock without exposing a canonical fragment", async () => {
    const outputRoot = await mkdtemp(path.join(tmpdir(), "exp0001a-authority-journal-mid-entry-"));
    roots.push(outputRoot);
    const directory = path.join(outputRoot, "authority-journal");
    await mkdir(directory, { mode: 0o700 });
    const crashedTemporary = path.join(
      directory,
      ".entry-000000.json-999999-00000000-0000-4000-8000-000000000000.tmp",
    );
    const staleLock = path.join(directory, ".append.lock");
    await writeFile(crashedTemporary, "{\"truncated\":", { mode: 0o600 });
    await writeFile(staleLock, "{\"schemaVersion\":", { mode: 0o600 });
    const old = new Date(Date.now() - 120_000);
    await utimes(crashedTemporary, old, old);
    await utimes(staleLock, old, old);

    const retained = await appendExp0001aAuthorityJournalEntry({
      outputRoot,
      kind: "coordinator_checkpoint",
      recordedAt: "2026-08-30T10:00:00.000Z",
      payload: { checkpointId: "checkpoint-after-kill", signed: true },
    });

    expect(retained).toMatchObject({ alreadyRetained: false, entry: { sequence: 0 } });
    expect((await readExp0001aAuthorityJournal(outputRoot)).entries).toHaveLength(1);
    expect(await readdir(directory)).toEqual(["entry-000000.json"]);
  });

  it("reclaims an old lock only when its recorded owner is definitely dead", async () => {
    const outputRoot = await mkdtemp(path.join(tmpdir(), "exp0001a-authority-journal-mid-lock-"));
    roots.push(outputRoot);
    const directory = path.join(outputRoot, "authority-journal");
    await mkdir(directory, { mode: 0o700 });
    const staleLock = path.join(directory, ".append.lock");
    const acquiredAt = new Date(Date.now() - 120_000).toISOString();
    await writeFile(staleLock, `${canonicalAuthorityJournalJson({
      schemaVersion: "exp-0001a-authority-journal-lock/v1",
      pid: 2_147_483_647,
      acquiredAt,
      ownerToken: "00000000-0000-4000-8000-000000000001",
    })}\n`, { mode: 0o600 });
    const old = new Date(Date.now() - 120_000);
    await utimes(staleLock, old, old);

    const retained = await appendExp0001aAuthorityJournalEntry({
      outputRoot,
      kind: "runtime_preflight",
      recordedAt: "2026-08-30T10:00:01.000Z",
      payload: { receiptDigest: "sha256:" + "b".repeat(64) },
    });

    expect(retained.entry.sequence).toBe(0);
    expect(await readdir(directory)).toEqual(["entry-000000.json"]);
  });

  it("serializes concurrent distinct and duplicate appends into one contiguous chain", async () => {
    const outputRoot = await mkdtemp(path.join(tmpdir(), "exp0001a-authority-journal-concurrent-"));
    roots.push(outputRoot);
    const distinct = Array.from({ length: 16 }, (_, index) => ({
      outputRoot,
      kind: "coordinator_action_result" as const,
      recordedAt: `2026-08-30T10:00:${String(index).padStart(2, "0")}.000Z`,
      payload: { action: index },
    }));
    const duplicate = {
      outputRoot,
      kind: "completion_draft" as const,
      recordedAt: "2026-08-30T10:01:00.000Z",
      payload: { completionDigest: "sha256:" + "c".repeat(64) },
    };

    const results = await Promise.all([
      ...distinct.map((input) => appendExp0001aAuthorityJournalEntry(input)),
      appendExp0001aAuthorityJournalEntry(duplicate),
      appendExp0001aAuthorityJournalEntry({ ...duplicate, recordedAt: "2026-08-30T10:01:01.000Z" }),
    ]);
    const retained = await readExp0001aAuthorityJournal(outputRoot);

    expect(retained.entries).toHaveLength(17);
    expect(retained.entries.map((entry: { sequence: number }) => entry.sequence)).toEqual(
      Array.from({ length: 17 }, (_, index) => index),
    );
    expect(retained.entries.slice(1).every((entry: { priorEntryDigest: string }, index: number) =>
      entry.priorEntryDigest === retained.entries[index].entryDigest)).toBe(true);
    expect(results.filter((result: { alreadyRetained: boolean }) => result.alreadyRetained)).toHaveLength(1);
    expect((await readdir(path.join(outputRoot, "authority-journal"))).every((name) => /^entry-[0-9]{6}\.json$/.test(name))).toBe(true);
  });
});
