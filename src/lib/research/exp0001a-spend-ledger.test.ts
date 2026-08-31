import {
  chmod,
  chown,
  link,
  mkdtemp,
  readFile,
  readdir,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalJson } from "./provenance-crypto";
import {
  computeExp0001aSpendAnchorDigest,
  computeExp0001aSpendEventDigest,
  computeExp0001aSpendLedgerRoot,
  createExp0001aSpendLedger,
  defaultExp0001aSpendAnchorDirectory,
  readExp0001aSpendLedger,
  setExp0001aSpendDescriptorOpenedObserverForTest,
} from "./exp0001a-spend-ledger";

const digest = (character: string) => `sha256:${character.repeat(64)}`;

async function ledger(cap = 10) {
  const root = await mkdtemp(path.join(os.tmpdir(), "exp0001a-spend-"));
  return { root, value: createExp0001aSpendLedger({ directory: root, authorizedMaximumUsd: cap, authorizationReceiptDigest: digest("a") }) };
}

async function onlyEventPath(root: string): Promise<string> {
  const names = await readdir(root);
  if (names.length !== 1) throw new Error(`Expected one retained event, found ${names.length}.`);
  return path.join(root, names[0]);
}

describe("EXP-0001A append-only spend ledger", () => {
  it("reserves before release and replaces the reservation with exact observed cost", async () => {
    const { value } = await ledger();
    const reservation = await value.reserve({
      at: "2026-08-30T10:00:00.000Z",
      callId: "primary:item-1",
      phase: "primary",
      maximumCostUsd: 2,
      budgetDigest: digest("b"),
      pricingDigest: digest("c"),
    });
    expect((await value.read()).summary).toMatchObject({ observedSettledUsd: 0, unobservableReservedExposureUsd: 2, totalChargedExposureUsd: 2 });
    await value.settle({
      at: "2026-08-30T10:01:00.000Z",
      callId: "primary:item-1",
      phase: "primary",
      observability: "observed",
      actualCostUsd: 0.25,
      usageDigest: digest("d"),
      providerReceiptDigest: digest("e"),
    });
    const result = await value.read();
    expect(result.summary).toMatchObject({ observedSettledUsd: 0.25, unobservableReservedExposureUsd: 0, totalChargedExposureUsd: 0.25, settlementCount: 1 });
    expect(reservation.eventDigest).toMatch(/^sha256:/);
  });

  it("keeps a begun call without a receipt as conservative charged exposure after restart", async () => {
    const { root, value } = await ledger();
    await value.reserve({
      at: "2026-08-30T10:00:00.000Z",
      callId: "pairwise:item-7",
      phase: "pairwise",
      maximumCostUsd: 3.5,
      budgetDigest: digest("b"),
      pricingDigest: digest("c"),
    });
    const restarted = createExp0001aSpendLedger({ directory: root, authorizedMaximumUsd: 10, authorizationReceiptDigest: digest("a") });
    expect((await restarted.read()).summary).toMatchObject({
      observedSettledUsd: 0,
      unobservableReservedExposureUsd: 3.5,
      pendingCallIds: ["pairwise:item-7"],
    });
  });

  it("commits every valid append to a separate monotonic external anchor chain", async () => {
    const { root, value } = await ledger();
    const empty = await value.read();
    const emptyRoot = empty.summary.externalAnchorRoot;
    await value.reserve({
      at: "2026-08-30T10:00:00.000Z",
      callId: "primary:item-1",
      phase: "primary",
      maximumCostUsd: 2,
      budgetDigest: digest("b"),
      pricingDigest: digest("c"),
    });
    const reserved = await value.read();
    expect(reserved.summary.externalAnchorCount).toBe(1);
    expect(reserved.summary.externalAnchorRoot).not.toBe(emptyRoot);
    await value.settle({
      at: "2026-08-30T10:01:00.000Z",
      callId: "primary:item-1",
      phase: "primary",
      observability: "observed",
      actualCostUsd: 0.25,
      usageDigest: digest("d"),
      providerReceiptDigest: digest("e"),
    });
    const settled = await value.read();
    expect(settled.summary.externalAnchorCount).toBe(2);
    expect(settled.summary.externalAnchorRoot).not.toBe(reserved.summary.externalAnchorRoot);
    expect(await readdir(defaultExp0001aSpendAnchorDirectory(root))).toHaveLength(2);
    await expect(readExp0001aSpendLedger(root, 10, digest("a"), {
      expectedExternalAnchorRoot: reserved.summary.externalAnchorRoot,
    })).rejects.toThrow(/externally bound expected root/);
    await expect(readExp0001aSpendLedger(root, 10, digest("a"), {
      expectedExternalAnchorRoot: settled.summary.externalAnchorRoot,
    })).resolves.toMatchObject({ summary: { externalAnchorCount: 2 } });
  });

  it("refuses cap exhaustion before retaining another provider release", async () => {
    const { root, value } = await ledger(4);
    await value.reserve({ at: "2026-08-30T10:00:00.000Z", callId: "author:a", phase: "author", maximumCostUsd: 3, budgetDigest: digest("b"), pricingDigest: digest("c") });
    await expect(value.reserve({ at: "2026-08-30T10:00:01.000Z", callId: "author:b", phase: "author", maximumCostUsd: 2, budgetDigest: digest("b"), pricingDigest: digest("c") })).rejects.toThrow("SPEND_CAP_EXHAUSTED");
    expect(await readdir(root)).toHaveLength(1);
  });

  it("never permits a settled call to be reserved or invoked twice", async () => {
    const { value } = await ledger();
    const input = { at: "2026-08-30T10:00:00.000Z", callId: "primary:item-1", phase: "primary" as const, maximumCostUsd: 2, budgetDigest: digest("b"), pricingDigest: digest("c") };
    await value.reserve(input);
    await value.settle({ at: "2026-08-30T10:01:00.000Z", callId: input.callId, phase: "primary", observability: "attested_no_provider_call", actualCostUsd: 0, usageDigest: null, providerReceiptDigest: null });
    await expect(value.reserve(input)).rejects.toThrow("already settled");
  });

  it("fails closed when retained bytes are altered", async () => {
    const { root, value } = await ledger();
    await value.reserve({ at: "2026-08-30T10:00:00.000Z", callId: "author:a", phase: "author", maximumCostUsd: 1, budgetDigest: digest("b"), pricingDigest: digest("c") });
    const [name] = await readdir(root);
    const raw = JSON.parse(await readFile(path.join(root, name), "utf8"));
    raw.maximumCostUsd = 0.5;
    await import("node:fs/promises").then(({ writeFile }) => writeFile(path.join(root, name), JSON.stringify(raw)));
    await expect(value.read()).rejects.toThrow(/hash chain|external anchor/);
  });

  it("rejects noncanonical bytes even when they encode the exact valid event", async () => {
    const { root, value } = await ledger();
    await value.reserve({ at: "2026-08-30T10:00:00.000Z", callId: "author:a", phase: "author", maximumCostUsd: 1, budgetDigest: digest("b"), pricingDigest: digest("c") });
    const eventPath = await onlyEventPath(root);
    const event = JSON.parse(await readFile(eventPath, "utf8"));
    await writeFile(eventPath, JSON.stringify(event, null, 2), { mode: 0o600 });
    await expect(value.read()).rejects.toThrow(/exact canonical JSON/);
  });

  it("rejects mode drift, hard links, and symbolic-link replacement", async () => {
    const modeFixture = await ledger();
    await modeFixture.value.reserve({ at: "2026-08-30T10:00:00.000Z", callId: "author:mode", phase: "author", maximumCostUsd: 1, budgetDigest: digest("b"), pricingDigest: digest("c") });
    await chmod(await onlyEventPath(modeFixture.root), 0o640);
    await expect(modeFixture.value.read()).rejects.toThrow(/mode-0600/);

    const linkFixture = await ledger();
    await linkFixture.value.reserve({ at: "2026-08-30T10:00:00.000Z", callId: "author:hardlink", phase: "author", maximumCostUsd: 1, budgetDigest: digest("b"), pricingDigest: digest("c") });
    const linkedEvent = await onlyEventPath(linkFixture.root);
    await link(linkedEvent, `${linkFixture.root}.outside-ledger.json`);
    await expect(linkFixture.value.read()).rejects.toThrow(/singly linked/);

    const symlinkFixture = await ledger();
    await symlinkFixture.value.reserve({ at: "2026-08-30T10:00:00.000Z", callId: "author:symlink", phase: "author", maximumCostUsd: 1, budgetDigest: digest("b"), pricingDigest: digest("c") });
    const symlinkEvent = await onlyEventPath(symlinkFixture.root);
    const displaced = `${symlinkFixture.root}.displaced-event.json`;
    await rename(symlinkEvent, displaced);
    await symlink(displaced, symlinkEvent);
    await expect(symlinkFixture.value.read()).rejects.toThrow();
  });

  it.skipIf(typeof process.getuid !== "function" || process.getuid() !== 0)(
    "rejects an event owned by another operating-system user",
    async () => {
      const { root, value } = await ledger();
      await value.reserve({ at: "2026-08-30T10:00:00.000Z", callId: "author:owner", phase: "author", maximumCostUsd: 1, budgetDigest: digest("b"), pricingDigest: digest("c") });
      await chown(await onlyEventPath(root), 1, 1);
      await expect(value.read()).rejects.toThrow(/owner-controlled/);
    },
  );

  it("detects a pathname replacement after O_NOFOLLOW open instead of reading the replacement", async () => {
    const { root, value } = await ledger();
    await value.reserve({ at: "2026-08-30T10:00:00.000Z", callId: "author:swap", phase: "author", maximumCostUsd: 1, budgetDigest: digest("b"), pricingDigest: digest("c") });
    const eventPath = await onlyEventPath(root);
    const original = await readFile(eventPath);
    const displaced = `${root}.post-open-original.json`;
    setExp0001aSpendDescriptorOpenedObserverForTest(async (openedPath) => {
      if (openedPath !== eventPath) return;
      setExp0001aSpendDescriptorOpenedObserverForTest(null);
      await rename(eventPath, displaced);
      await writeFile(eventPath, original, { mode: 0o600 });
    });
    try {
      await expect(value.read()).rejects.toThrow(/pathname was replaced/);
    } finally {
      setExp0001aSpendDescriptorOpenedObserverForTest(null);
    }
  });

  it("rejects a fully recomputed unkeyed ledger rewrite against the independent anchor", async () => {
    const { root, value } = await ledger();
    await value.reserve({ at: "2026-08-30T10:00:00.000Z", callId: "author:forged", phase: "author", maximumCostUsd: 1, budgetDigest: digest("b"), pricingDigest: digest("c") });
    const originalPath = await onlyEventPath(root);
    const forged = JSON.parse(await readFile(originalPath, "utf8"));
    forged.maximumCostUsd = 1.5;
    forged.eventDigest = computeExp0001aSpendEventDigest(forged);
    const forgedName = `${String(forged.sequence).padStart(6, "0")}-${forged.eventDigest.slice(7, 23)}.json`;
    await unlink(originalPath);
    await writeFile(path.join(root, forgedName), canonicalJson(forged), { mode: 0o600 });
    await expect(value.read()).rejects.toThrow(/external anchor chain does not match/);
  });

  it("requires an externally retained root to detect a coordinated rewrite of both local chains", async () => {
    const { root, value } = await ledger();
    await value.reserve({ at: "2026-08-30T10:00:00.000Z", callId: "author:coordinated-forge", phase: "author", maximumCostUsd: 1, budgetDigest: digest("b"), pricingDigest: digest("c") });
    const boundRoot = (await value.read()).summary.externalAnchorRoot;
    const originalEventPath = await onlyEventPath(root);
    const anchorDirectory = defaultExp0001aSpendAnchorDirectory(root);
    const [originalAnchorName] = await readdir(anchorDirectory);
    const originalAnchorPath = path.join(anchorDirectory, originalAnchorName);
    const forgedEvent = JSON.parse(await readFile(originalEventPath, "utf8"));
    forgedEvent.maximumCostUsd = 1.5;
    forgedEvent.eventDigest = computeExp0001aSpendEventDigest(forgedEvent);
    const forgedAnchor = JSON.parse(await readFile(originalAnchorPath, "utf8"));
    forgedAnchor.event = forgedEvent;
    forgedAnchor.ledgerRoot = computeExp0001aSpendLedgerRoot([forgedEvent]);
    forgedAnchor.anchorDigest = computeExp0001aSpendAnchorDigest(forgedAnchor);
    await unlink(originalEventPath);
    await unlink(originalAnchorPath);
    await writeFile(
      path.join(root, `000000-${forgedEvent.eventDigest.slice(7, 23)}.json`),
      canonicalJson(forgedEvent),
      { mode: 0o600 },
    );
    await writeFile(
      path.join(anchorDirectory, `000000-${forgedAnchor.anchorDigest.slice(7, 23)}.json`),
      canonicalJson(forgedAnchor),
      { mode: 0o600 },
    );
    await expect(value.read()).resolves.toMatchObject({ summary: { externalAnchorCount: 1 } });
    await expect(readExp0001aSpendLedger(root, 10, digest("a"), {
      expectedExternalAnchorRoot: boundRoot,
    })).rejects.toThrow(/externally bound expected root/);
  });

  it("rejects a stale external anchor tail rather than accepting an unanchored event", async () => {
    const { root, value } = await ledger();
    await value.reserve({ at: "2026-08-30T10:00:00.000Z", callId: "author:stale", phase: "author", maximumCostUsd: 1, budgetDigest: digest("b"), pricingDigest: digest("c") });
    const anchorDirectory = defaultExp0001aSpendAnchorDirectory(root);
    const [anchorName] = await readdir(anchorDirectory);
    await rename(path.join(anchorDirectory, anchorName), `${root}.stale-anchor.json`);
    await expect(value.read()).rejects.toThrow(/different lengths/);
  });

  it("recovers exactly one anchor-first crash tail without inventing new evidence", async () => {
    const { root, value } = await ledger();
    const retained = await value.reserve({ at: "2026-08-30T10:00:00.000Z", callId: "author:recover", phase: "author", maximumCostUsd: 1, budgetDigest: digest("b"), pricingDigest: digest("c") });
    const eventPath = await onlyEventPath(root);
    await unlink(eventPath);
    await expect(readExp0001aSpendLedger(root, 10, digest("a"))).rejects.toThrow(/different lengths/);
    const restarted = createExp0001aSpendLedger({ directory: root, authorizedMaximumUsd: 10, authorizationReceiptDigest: digest("a") });
    const recovered = await restarted.read();
    expect(recovered.events).toEqual([retained]);
    expect(await readFile(eventPath, "utf8")).toBe(canonicalJson(retained));
  });

  it("rejects every unexpected directory entry instead of silently omitting evidence", async () => {
    const { root, value } = await ledger();
    await writeFile(path.join(root, ".DS_Store"), "untrusted sidecar");
    await expect(value.read()).rejects.toThrow(/unexpected entries.*\.DS_Store/);
  });

  it("rejects reservations retained under another authorization receipt", async () => {
    const { root, value } = await ledger();
    await value.reserve({
      at: "2026-08-30T10:00:00.000Z",
      callId: "author:a",
      phase: "author",
      maximumCostUsd: 1,
      budgetDigest: digest("b"),
      pricingDigest: digest("c"),
    });
    const forgedAuthority = createExp0001aSpendLedger({
      directory: root,
      authorizedMaximumUsd: 10,
      authorizationReceiptDigest: digest("f"),
    });
    await expect(forgedAuthority.read()).rejects.toThrow(/another authorization receipt/);
  });
});
