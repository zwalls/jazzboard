import { describe, expect, it, vi } from "vitest";

import { CanvasObjectSyncCoordinator } from "./sync-coordinator";
import type { ObjectLease } from "@/lib/domain/types";

describe("CanvasObjectSyncCoordinator", () => {
  const lease = (objectId: string, revision: number): ObjectLease => ({
    leaseId: `lease-${objectId}`,
    objectId,
    actor: {
      participantId: "participant",
      kind: "human",
      displayName: "Participant",
      color: "blue",
    },
    operation: "move",
    objectRevision: revision,
    acquiredAt: 1_000,
    expiresAt: 5_000,
  });

  it("protects an interaction before it becomes dirty and settles only after its latest generation", () => {
    const coordinator = new CanvasObjectSyncCoordinator();
    coordinator.beginInteraction("node", 4);
    expect(coordinator.protectedObjectIds()).toEqual(new Set(["node"]));

    const first = coordinator.markDirty({ objectId: "node", shapeId: "shape:node", baseRevision: 4 });
    const second = coordinator.markDirty({ objectId: "node", shapeId: "shape:node", baseRevision: 4 });
    coordinator.endInteraction("node");

    expect(coordinator.acknowledge("node", first.generation, 5)).toBe(false);
    expect(coordinator.protectedObjectIds()).toEqual(new Set(["node"]));
    expect(coordinator.acknowledge("node", second.generation, 6)).toBe(true);
    expect(coordinator.protectedObjectIds()).toEqual(new Set());
    expect(coordinator.get("node")?.baseRevision).toBe(6);
  });

  it("serializes work for one object without blocking another object", async () => {
    const coordinator = new CanvasObjectSyncCoordinator();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = coordinator.enqueue("node", async () => {
      events.push("node:first:start");
      await firstGate;
      events.push("node:first:end");
    });
    const second = coordinator.enqueue("node", async () => {
      events.push("node:second");
    });
    const other = coordinator.enqueue("other", async () => {
      events.push("other");
    });

    await vi.waitFor(() => expect(events).toContain("other"));
    expect(events).toEqual(["node:first:start", "other"]);
    releaseFirst();
    await Promise.all([first, second, other]);
    expect(events).toEqual(["node:first:start", "other", "node:first:end", "node:second"]);
  });

  it("serializes a batch after every object tail and gates later work for every member", async () => {
    const coordinator = new CanvasObjectSyncCoordinator();
    const events: string[] = [];
    let releaseA!: () => void;
    let releaseB!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const gateB = new Promise<void>((resolve) => {
      releaseB = resolve;
    });

    const beforeA = coordinator.enqueue("a", async () => {
      events.push("a:start");
      await gateA;
      events.push("a:end");
    });
    const beforeB = coordinator.enqueue("b", async () => {
      events.push("b:start");
      await gateB;
      events.push("b:end");
    });
    const batch = coordinator.enqueueBatch(["a", "b"], async () => {
      events.push("batch");
    });
    const afterA = coordinator.enqueue("a", async () => {
      events.push("a:after");
    });
    const afterB = coordinator.enqueue("b", async () => {
      events.push("b:after");
    });

    await vi.waitFor(() => expect(events).toEqual(["a:start", "b:start"]));
    releaseA();
    await vi.waitFor(() => expect(events).toContain("a:end"));
    expect(events).not.toContain("batch");
    releaseB();
    await Promise.all([beforeA, beforeB, batch, afterA, afterB]);

    expect(events.indexOf("batch")).toBeGreaterThan(events.indexOf("a:end"));
    expect(events.indexOf("batch")).toBeGreaterThan(events.indexOf("b:end"));
    expect(events.indexOf("a:after")).toBeGreaterThan(events.indexOf("batch"));
    expect(events.indexOf("b:after")).toBeGreaterThan(events.indexOf("batch"));
  });

  it("deduplicates batch IDs and accounts for one queued task per entry", async () => {
    const coordinator = new CanvasObjectSyncCoordinator();
    const settled: string[] = [];
    let releaseBatch!: () => void;
    const batchGate = new Promise<void>((resolve) => {
      releaseBatch = resolve;
    });

    const batch = coordinator.enqueueBatch(
      ["a", "a", "b", "b", "a"],
      () => batchGate,
      (entry) => settled.push(entry.objectId),
    );

    expect(coordinator.get("a")?.queuedTasks).toBe(1);
    expect(coordinator.get("b")?.queuedTasks).toBe(1);
    releaseBatch();
    await batch;
    await vi.waitFor(() => expect(settled).toHaveLength(2));

    expect(settled.sort()).toEqual(["a", "b"]);
    expect(coordinator.get("a")?.queuedTasks).toBe(0);
    expect(coordinator.get("b")?.queuedTasks).toBe(0);
  });

  it("adopts a newer settled base revision even while lease release is pending", () => {
    const coordinator = new CanvasObjectSyncCoordinator();
    const entry = coordinator.getOrCreate("node", 3);
    entry.releaseRequest = Promise.resolve();

    coordinator.beginInteraction("node", 7);

    expect(entry.baseRevision).toBe(7);
    expect(coordinator.protectedObjectIds()).toEqual(new Set(["node"]));
  });

  it("invalidates stale lease intents without cancelling a newer operation", () => {
    const coordinator = new CanvasObjectSyncCoordinator();
    const move = coordinator.desireLease("node", "move");

    expect(coordinator.hasLeaseIntent(move.entry, move.epoch, "move")).toBe(true);
    coordinator.cancelLeaseIntent("node");
    expect(coordinator.hasLeaseIntent(move.entry, move.epoch, "move")).toBe(false);

    const resize = coordinator.desireLease("node", "resize");
    expect(resize.epoch).toBeGreaterThan(move.epoch);
    expect(coordinator.hasLeaseIntent(resize.entry, resize.epoch, "resize")).toBe(true);
    expect(coordinator.hasLeaseIntent(move.entry, move.epoch, "move")).toBe(false);
  });

  it("does not replace a dirty object's base revision", () => {
    const coordinator = new CanvasObjectSyncCoordinator();
    coordinator.markDirty({ objectId: "node", shapeId: "shape:node", baseRevision: 3 });

    coordinator.getOrCreate("node", 9);
    coordinator.beginInteraction("node", 10);

    expect(coordinator.get("node")?.baseRevision).toBe(3);
  });

  it("keeps a newer generation protected when delayed acknowledgements settle in order", async () => {
    const coordinator = new CanvasObjectSyncCoordinator();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = coordinator.markDirty({
      objectId: "node",
      shapeId: "shape:node",
      baseRevision: 4,
    });

    const firstSave = coordinator.enqueue("node", async () => {
      await firstGate;
      expect(coordinator.acknowledge("node", first.generation, 5)).toBe(false);
    });
    const second = coordinator.markDirty({
      objectId: "node",
      shapeId: "shape:node",
      baseRevision: 4,
    });
    const secondSave = coordinator.enqueue("node", async () => {
      expect(coordinator.protectedObjectIds()).toEqual(new Set(["node"]));
      expect(coordinator.acknowledge("node", second.generation, 6)).toBe(true);
    });

    releaseFirst();
    await Promise.all([firstSave, secondSave]);

    expect(coordinator.get("node")?.baseRevision).toBe(6);
    expect(coordinator.protectedObjectIds()).toEqual(new Set());
  });

  it("stays protected while lease acquisition and the edited generation are delayed", async () => {
    const coordinator = new CanvasObjectSyncCoordinator();
    const entry = coordinator.beginInteraction("node", 4, 1_000);
    let resolveLease!: (value: ObjectLease | null) => void;
    entry.leaseRequest = new Promise<ObjectLease | null>((resolve) => {
      resolveLease = resolve;
    });
    const edit = coordinator.markDirty({
      objectId: "node",
      shapeId: "shape:node",
      baseRevision: 4,
      baseCreatedAt: 1_000,
    });
    coordinator.endInteraction("node");

    expect(coordinator.protectedObjectIds()).toEqual(new Set(["node"]));
    expect(coordinator.canPrune(entry)).toBe(false);
    resolveLease(lease("node", 4));
    const acquired = await entry.leaseRequest;
    if (!acquired) throw new Error("The delayed lease did not resolve.");
    entry.lease = { lease: acquired, renewTimer: null };
    entry.leaseRequest = null;
    expect(coordinator.acknowledge("node", edit.generation, 5, {
      expectedCreatedAt: 1_000,
      authoritativeCreatedAt: 1_000,
    })).toBe(true);
    expect(coordinator.protectedObjectIds()).toEqual(new Set());
    expect(coordinator.canSettle(entry)).toBe(true);
    expect(coordinator.canPrune(entry)).toBe(false);

    entry.lease = null;
    expect(coordinator.canPrune(entry)).toBe(true);
  });

  it("uses recovery epochs to invalidate work queued before a completed rollback", () => {
    const coordinator = new CanvasObjectSyncCoordinator();
    const queued = coordinator.markDirty({
      objectId: "node",
      shapeId: "shape:node",
      baseRevision: 2,
      baseCreatedAt: 1_000,
    });
    const queuedRecoveryEpoch = queued.entry.recoveryEpoch;

    coordinator.beginRecovery("node");
    coordinator.completeRecovery("node", 3, 1_000);
    const newer = coordinator.markDirty({
      objectId: "node",
      shapeId: "shape:node",
      baseRevision: 3,
      baseCreatedAt: 1_000,
    });

    expect(newer.entry.recoveryEpoch).toBe(queuedRecoveryEpoch + 1);
    expect(newer.entry.dirty).toBe(true);
    expect(newer.entry.generation).toBeGreaterThan(queued.generation);
  });

  it("invalidates old acknowledgements while authoritative recovery is pending", () => {
    const coordinator = new CanvasObjectSyncCoordinator();
    const { generation } = coordinator.markDirty({
      objectId: "copy",
      shapeId: "shape:copy",
      baseRevision: 2,
    });

    expect(coordinator.beginRecovery("copy")).not.toBeNull();
    expect(coordinator.hasPendingRecovery()).toBe(true);
    expect(coordinator.acknowledge("copy", generation, 3)).toBe(false);
    expect(coordinator.protectedObjectIds()).toEqual(new Set(["copy"]));

    coordinator.completeRecovery("copy", 4);
    expect(coordinator.hasPendingRecovery()).toBe(false);
    expect(coordinator.protectedObjectIds()).toEqual(new Set());
    expect(coordinator.get("copy")?.baseRevision).toBe(4);
  });

  it("keeps pending creations and deletion tombstones protected", () => {
    const coordinator = new CanvasObjectSyncCoordinator();
    const created = coordinator.markDirty({ objectId: "new", shapeId: "shape:new", baseRevision: null });
    const deleted = coordinator.markDirty({
      objectId: "old",
      shapeId: "shape:old",
      baseRevision: 7,
      deleted: true,
    });

    expect(coordinator.get("old")?.deleted).toBe(true);
    expect(coordinator.protectedObjectIds()).toEqual(new Set(["new", "old"]));
    coordinator.acknowledge("new", created.generation, 1);
    coordinator.acknowledge("old", deleted.generation, null);
    expect(coordinator.protectedObjectIds()).toEqual(new Set());
  });

  it("ignores a delayed acknowledgement from an old incarnation after same-ID recreation", () => {
    const coordinator = new CanvasObjectSyncCoordinator();
    coordinator.getOrCreate("node", 8, 1_000);
    const staleDeletion = coordinator.markDirty({
      objectId: "node",
      shapeId: "shape:node",
      baseRevision: 8,
      baseCreatedAt: 1_000,
      deleted: true,
    });

    // An authoritative refresh has already found a new object reusing the ID.
    coordinator.completeRecovery("node", 1, 2_000);
    const recreatedEdit = coordinator.markDirty({
      objectId: "node",
      shapeId: "shape:node",
      baseRevision: 1,
      baseCreatedAt: 2_000,
    });

    expect(
      coordinator.acknowledge("node", staleDeletion.generation, null, {
        expectedCreatedAt: staleDeletion.incarnation,
        authoritativeCreatedAt: null,
      }),
    ).toBe(false);
    expect(coordinator.get("node")).toMatchObject({
      baseRevision: 1,
      baseCreatedAt: 2_000,
      dirty: true,
      generation: recreatedEdit.generation,
    });
    expect(coordinator.protectedObjectIds()).toEqual(new Set(["node"]));

    expect(
      coordinator.acknowledge("node", recreatedEdit.generation, 2, {
        expectedCreatedAt: recreatedEdit.incarnation,
        authoritativeCreatedAt: 2_000,
      }),
    ).toBe(true);
    expect(coordinator.get("node")).toMatchObject({
      baseRevision: 2,
      baseCreatedAt: 2_000,
      dirty: false,
    });
  });

  it("adopts a lower revision when authoritative state has a newer incarnation", () => {
    const coordinator = new CanvasObjectSyncCoordinator();
    const entry = coordinator.getOrCreate("node", 12, 1_000);

    coordinator.getOrCreate("node", 1, 2_000);

    expect(entry.baseRevision).toBe(1);
    expect(entry.baseCreatedAt).toBe(2_000);
    expect(
      coordinator.acknowledge("node", entry.generation, 13, {
        expectedCreatedAt: 1_000,
        authoritativeCreatedAt: 1_000,
      }),
    ).toBe(false);
    expect(entry.baseRevision).toBe(1);
    expect(entry.baseCreatedAt).toBe(2_000);
  });

  it("records the authoritative incarnation when a pending create is acknowledged", () => {
    const coordinator = new CanvasObjectSyncCoordinator();
    const created = coordinator.markDirty({
      objectId: "new",
      shapeId: "shape:new",
      baseRevision: null,
      baseCreatedAt: null,
    });

    expect(
      coordinator.acknowledge("new", created.generation, 1, {
        expectedCreatedAt: created.incarnation,
        authoritativeCreatedAt: 3_000,
      }),
    ).toBe(true);
    expect(coordinator.get("new")).toMatchObject({
      baseRevision: 1,
      baseCreatedAt: 3_000,
      dirty: false,
    });
  });
});
