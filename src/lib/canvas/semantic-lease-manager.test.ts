import { afterEach, describe, expect, it, vi } from "vitest";

import type { ObjectLease, RoomState } from "@/lib/domain/types";
import { CanvasObjectSyncCoordinator } from "./sync-coordinator";
import {
  SEMANTIC_LEASE_RENEWAL_INTERVAL_MS,
  SemanticLeaseCohortManager,
  SemanticLeaseManagerError,
  type SemanticLeaseAction,
  type SemanticLeaseBatchAction,
  type SemanticLeaseBatchResult,
  type SemanticLeaseCohortManagerOptions,
  type SemanticLeaseResult,
} from "./semantic-lease-manager";

const target = (objectId: string, expectedRevision = 1) => ({
  objectId,
  expectedRevision,
  operation: "move" as const,
});

function room(stateRevision: number): RoomState {
  return { stateRevision } as unknown as RoomState;
}

function objectLease(
  objectId: string,
  objectRevision = 1,
  expiresAt = 5_000,
): ObjectLease {
  return {
    leaseId: `lease-${objectId}`,
    objectId,
    actor: {
      participantId: "participant",
      kind: "human",
      displayName: "Participant",
      color: "blue",
    },
    operation: "move",
    objectRevision,
    acquiredAt: 1_000,
    expiresAt,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function staleLeaseError(): Error & { code: "LEASE_NOT_FOUND" } {
  return Object.assign(new Error("stale lease"), { code: "LEASE_NOT_FOUND" as const });
}

function managerOptions(input: Readonly<{
  coordinator?: CanvasObjectSyncCoordinator;
  lease: (action: SemanticLeaseAction) => Promise<SemanticLeaseResult>;
  leaseMany: (action: SemanticLeaseBatchAction) => Promise<SemanticLeaseBatchResult>;
  onRoom?: (next: RoomState) => void;
  onCohortRecovery?: SemanticLeaseCohortManagerOptions["onCohortRecovery"];
}>): SemanticLeaseCohortManagerOptions {
  return {
    coordinator: input.coordinator ?? new CanvasObjectSyncCoordinator(),
    lease: input.lease,
    leaseMany: input.leaseMany,
    onRoom: input.onRoom ?? (() => undefined),
    isLeaseNotFound: (error) =>
      typeof error === "object" && error !== null && "code" in error &&
      error.code === "LEASE_NOT_FOUND",
    onCohortRecovery: input.onCohortRecovery ?? (() => undefined),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SemanticLeaseCohortManager", () => {
  it("acquires every missing member in one atomic batch", async () => {
    const acquired = [objectLease("a", 2), objectLease("b", 7)];
    const lease = vi.fn<(action: SemanticLeaseAction) => Promise<SemanticLeaseResult>>();
    const leaseMany = vi.fn(async (action: SemanticLeaseBatchAction) => {
      if (action.action === "acquire-many") {
        return { room: room(10), leases: acquired };
      }
      return { room: room(11), leases: [] };
    });
    const manager = new SemanticLeaseCohortManager(managerOptions({ lease, leaseMany }));

    const result = await manager.acquireCohort({
      cohortId: "gesture",
      targets: [target("a", 2), target("b", 7)],
    });

    expect(lease).not.toHaveBeenCalled();
    expect(leaseMany).toHaveBeenNthCalledWith(1, {
      action: "acquire-many",
      targets: [target("a", 2), target("b", 7)],
    });
    expect([...result.leases.keys()]).toEqual(["a", "b"]);
    await manager.releaseCohort("gesture");
  });

  it("deduplicates a delayed per-object acquisition and ref-counts overlapping cohorts", async () => {
    const acquire = deferred<SemanticLeaseResult>();
    const lease = vi.fn(async (action: SemanticLeaseAction) => {
      if (action.action === "acquire") return acquire.promise;
      return { room: room(3), lease: null };
    });
    const leaseMany = vi.fn<(action: SemanticLeaseBatchAction) => Promise<SemanticLeaseBatchResult>>();
    const manager = new SemanticLeaseCohortManager(managerOptions({ lease, leaseMany }));

    const first = manager.acquireCohort({ cohortId: "first", targets: [target("a")] });
    const second = manager.acquireCohort({ cohortId: "second", targets: [target("a")] });
    expect(manager.referenceCount("a")).toBe(2);
    expect(lease).toHaveBeenCalledTimes(1);

    acquire.resolve({ room: room(1), lease: objectLease("a") });
    await Promise.all([first, second]);

    const third = await manager.acquireCohort({ cohortId: "third", targets: [target("a")] });
    expect(third.leases.get("a")?.leaseId).toBe("lease-a");
    expect(lease.mock.calls.filter(([action]) => action.action === "acquire")).toHaveLength(1);
    expect(manager.referenceCount("a")).toBe(3);

    await manager.releaseCohort("first");
    await manager.releaseCohort("second");
    expect(lease.mock.calls.filter(([action]) => action.action === "release")).toHaveLength(0);
    expect(manager.getOwnedLease("a")).not.toBeNull();

    await manager.releaseCohort("third");
    expect(lease.mock.calls.filter(([action]) => action.action === "release")).toHaveLength(1);
    expect(manager.referenceCount("a")).toBe(0);
    expect(manager.getOwnedLease("a")).toBeNull();
  });

  it("refreshes the shared token to the newest overlapping operation without releasing ownership", async () => {
    let revision = 0;
    const lease = vi.fn(async (action: SemanticLeaseAction) => {
      revision += 1;
      if (action.action === "acquire") {
        return {
          room: room(revision),
          lease: {
            ...objectLease(action.objectId, action.expectedRevision),
            operation: action.operation,
          },
        };
      }
      return { room: room(revision), lease: null };
    });
    const leaseMany = vi.fn<(action: SemanticLeaseBatchAction) => Promise<SemanticLeaseBatchResult>>();
    const manager = new SemanticLeaseCohortManager(managerOptions({ lease, leaseMany }));

    const moving = await manager.acquireCohort({
      cohortId: "move",
      targets: [target("a")],
    });
    const editing = await manager.acquireCohort({
      cohortId: "edit",
      targets: [{ ...target("a"), operation: "edit" }],
    });

    expect(moving.leases.get("a")?.leaseId).toBe("lease-a");
    expect(editing.leases.get("a")).toMatchObject({
      leaseId: "lease-a",
      operation: "edit",
    });
    expect(lease.mock.calls.filter(([action]) => action.action === "acquire").map(
      ([action]) => action.action === "acquire" ? action.operation : null,
    )).toEqual(["move", "edit"]);

    await manager.releaseCohort("edit");
    expect(manager.getOwnedLease("a")).toMatchObject({ leaseId: "lease-a", operation: "move" });
    expect(lease.mock.calls.filter(([action]) => action.action === "acquire").map(
      ([action]) => action.action === "acquire" ? action.operation : null,
    )).toEqual(["move", "edit", "move"]);
    expect(lease.mock.calls.filter(([action]) => action.action === "release")).toHaveLength(0);
    expect(manager.referenceCount("a")).toBe(1);

    await manager.releaseCohort("move");
    expect(lease.mock.calls.filter(([action]) => action.action === "release")).toHaveLength(1);
  });

  it("transitions a delayed pointer-down move acquire to edit without an ownership gap", async () => {
    const moveAcquire = deferred<SemanticLeaseResult>();
    const editAcquire = deferred<SemanticLeaseResult>();
    const authoritativeOperations: string[] = [];
    const lease = vi.fn((action: SemanticLeaseAction) => {
      if (action.action === "acquire") {
        return action.operation === "edit" ? editAcquire.promise : moveAcquire.promise;
      }
      return Promise.resolve({ room: room(5), lease: null });
    });
    const leaseMany = vi.fn<(action: SemanticLeaseBatchAction) => Promise<SemanticLeaseBatchResult>>();
    const manager = new SemanticLeaseCohortManager(managerOptions({
      lease,
      leaseMany,
      onRoom: (next) => {
        const operation = (next as RoomState).leases?.a?.operation;
        if (operation) authoritativeOperations.push(operation);
      },
    }));

    const moving = manager.acquireCohort({ cohortId: "pointer-down", targets: [target("a")] });
    const editing = manager.acquireCohort({
      cohortId: "double-click-edit",
      targets: [{ ...target("a"), operation: "edit" }],
    });

    expect(lease.mock.calls.filter(([action]) => action.action === "acquire")).toHaveLength(1);
    moveAcquire.resolve({
      room: { ...room(1), leases: { a: objectLease("a") } } as RoomState,
      lease: objectLease("a"),
    });
    await vi.waitFor(() => {
      expect(lease.mock.calls.filter(([action]) => action.action === "acquire").map(
        ([action]) => action.action === "acquire" ? action.operation : null,
      )).toEqual(["move", "edit"]);
    });
    expect(lease.mock.calls.filter(([action]) => action.action === "release")).toHaveLength(0);

    const editLease = { ...objectLease("a"), operation: "edit" as const };
    editAcquire.resolve({
      room: { ...room(2), leases: { a: editLease } } as RoomState,
      lease: editLease,
    });
    const [moveSnapshot, editSnapshot] = await Promise.all([moving, editing]);

    expect(moveSnapshot.leases.get("a")).toMatchObject({ operation: "edit" });
    expect(editSnapshot.leases.get("a")).toMatchObject({ operation: "edit" });
    expect(manager.getOwnedLease("a")).toMatchObject({ operation: "edit" });
    expect(authoritativeOperations).toEqual(["move", "edit"]);
    expect(lease.mock.calls.filter(([action]) => action.action === "release")).toHaveLength(0);

    await manager.releaseCohort("pointer-down");
    expect(manager.getOwnedLease("a")).toMatchObject({ operation: "edit" });
    await manager.releaseCohort("double-click-edit");
  });

  it("restores the remaining operation when a newer refresh resolves during release", async () => {
    const editAcquire = deferred<SemanticLeaseResult>();
    const lease = vi.fn(async (action: SemanticLeaseAction) => {
      if (action.action === "acquire" && action.operation === "edit") {
        return editAcquire.promise;
      }
      if (action.action === "acquire") {
        return {
          room: room(3),
          lease: { ...objectLease(action.objectId), operation: action.operation },
        };
      }
      return { room: room(4), lease: null };
    });
    const leaseMany = vi.fn<(action: SemanticLeaseBatchAction) => Promise<SemanticLeaseBatchResult>>();
    const manager = new SemanticLeaseCohortManager(managerOptions({ lease, leaseMany }));
    await manager.acquireCohort({ cohortId: "move", targets: [target("a")] });
    const edit = manager.acquireCohort({
      cohortId: "edit",
      targets: [{ ...target("a"), operation: "edit" }],
    }).catch((error: unknown) => error);

    const releaseEdit = manager.releaseCohort("edit");
    editAcquire.resolve({
      room: room(2),
      lease: { ...objectLease("a"), operation: "edit" },
    });
    expect(await edit).toMatchObject({ code: "INACTIVE_COHORT" });
    await releaseEdit;

    expect(manager.getOwnedLease("a")).toMatchObject({ leaseId: "lease-a", operation: "move" });
    expect(lease.mock.calls.filter(([action]) => action.action === "acquire").map(
      ([action]) => action.action === "acquire" ? action.operation : null,
    )).toEqual(["move", "edit", "move"]);
    expect(lease.mock.calls.filter(([action]) => action.action === "release")).toHaveLength(0);
    await manager.releaseCohort("move");
  });

  it("extends an active cohort atomically and returns its complete token set", async () => {
    const lease = vi.fn(async (action: SemanticLeaseAction) => {
      if (action.action === "acquire") {
        return {
          room: room(action.objectId === "a" ? 1 : 2),
          lease: objectLease(action.objectId, action.expectedRevision),
        };
      }
      return { room: room(4), lease: null };
    });
    const leaseMany = vi.fn(async (action: SemanticLeaseBatchAction) => {
      if (action.action === "release-many") return { room: room(5), leases: [] };
      throw new Error(`Unexpected ${action.action}`);
    });
    const manager = new SemanticLeaseCohortManager(managerOptions({ lease, leaseMany }));
    await manager.ensureCohort({ cohortId: "frame-gesture", targets: [target("a")] });

    const extended = await manager.ensureCohort({
      cohortId: "frame-gesture",
      targets: [target("a"), target("b", 3)],
    });

    expect(lease.mock.calls.filter(([action]) => action.action === "acquire").map(
      ([action]) => action.objectId,
    )).toEqual(["a", "b"]);
    expect(extended.objectIds).toEqual(["a", "b"]);
    expect([...extended.leases.keys()]).toEqual(["a", "b"]);
    expect(manager.referenceCount("a")).toBe(1);
    expect(manager.referenceCount("b")).toBe(1);
    await manager.releaseCohort("frame-gesture");
  });

  it("folds a frame extension into a delayed initial acquisition", async () => {
    const firstAcquire = deferred<SemanticLeaseResult>();
    const lease = vi.fn(async (action: SemanticLeaseAction) => {
      if (action.action === "acquire" && action.objectId === "a") return firstAcquire.promise;
      if (action.action === "acquire") {
        return { room: room(2), lease: objectLease(action.objectId, action.expectedRevision) };
      }
      return { room: room(4), lease: null };
    });
    const leaseMany = vi.fn(async (action: SemanticLeaseBatchAction) => {
      if (action.action === "release-many") return { room: room(5), leases: [] };
      throw new Error(`Unexpected ${action.action}`);
    });
    const manager = new SemanticLeaseCohortManager(managerOptions({ lease, leaseMany }));

    const initial = manager.ensureCohort({
      cohortId: "delayed-frame",
      targets: [target("a")],
    });
    const extended = manager.ensureCohort({
      cohortId: "delayed-frame",
      targets: [target("a"), target("b", 2)],
    });
    expect(lease.mock.calls.filter(([action]) => action.action === "acquire")).toHaveLength(1);

    firstAcquire.resolve({ room: room(1), lease: objectLease("a") });
    const [initialSnapshot, extendedSnapshot] = await Promise.all([initial, extended]);

    expect(initialSnapshot.objectIds).toEqual(["a", "b"]);
    expect(extendedSnapshot.objectIds).toEqual(["a", "b"]);
    expect(lease.mock.calls.filter(([action]) => action.action === "acquire").map(
      ([action]) => action.objectId,
    )).toEqual(["a", "b"]);
    await manager.releaseCohort("delayed-frame");
  });

  it("treats repeated identical discoveries as idempotent", async () => {
    const lease = vi.fn(async (action: SemanticLeaseAction) => {
      if (action.action === "acquire") {
        return { room: room(1), lease: objectLease(action.objectId) };
      }
      return { room: room(2), lease: null };
    });
    const leaseMany = vi.fn<(action: SemanticLeaseBatchAction) => Promise<SemanticLeaseBatchResult>>();
    const manager = new SemanticLeaseCohortManager(managerOptions({ lease, leaseMany }));

    await manager.ensureCohort({
      cohortId: "idempotent",
      targets: [target("a"), target("a")],
    });
    const repeated = await manager.ensureCohort({
      cohortId: "idempotent",
      targets: [target("a")],
    });

    expect(repeated.objectIds).toEqual(["a"]);
    expect(manager.referenceCount("a")).toBe(1);
    expect(lease.mock.calls.filter(([action]) => action.action === "acquire")).toHaveLength(1);
    await manager.releaseCohort("idempotent");
  });

  it("fences a rediscovered member with a conflicting base revision or operation", async () => {
    const lease = vi.fn(async (action: SemanticLeaseAction) => {
      if (action.action === "acquire") {
        return { room: room(1), lease: objectLease(action.objectId) };
      }
      return { room: room(2), lease: null };
    });
    const leaseMany = vi.fn<(action: SemanticLeaseBatchAction) => Promise<SemanticLeaseBatchResult>>();
    const manager = new SemanticLeaseCohortManager(managerOptions({ lease, leaseMany }));
    await manager.ensureCohort({ cohortId: "conflict", targets: [target("a")] });

    const revisionConflict = await manager.ensureCohort({
      cohortId: "conflict",
      targets: [target("a", 2)],
    }).catch((error: unknown) => error);
    const operationConflict = await manager.ensureCohort({
      cohortId: "conflict",
      targets: [{ ...target("a"), operation: "edit" }],
    }).catch((error: unknown) => error);

    expect(revisionConflict).toMatchObject({ code: "CONFLICTING_TARGET" });
    expect(operationConflict).toMatchObject({ code: "CONFLICTING_TARGET" });
    expect(manager.referenceCount("a")).toBe(1);
    expect(lease.mock.calls.filter(([action]) => action.action === "acquire")).toHaveLength(1);
    await manager.releaseCohort("conflict");
  });

  it("fences and cleans up an active extension that resolves after early release", async () => {
    const extensionAcquire = deferred<SemanticLeaseResult>();
    const lease = vi.fn(async (action: SemanticLeaseAction) => {
      if (action.action === "acquire" && action.objectId === "a") {
        return { room: room(1), lease: objectLease("a") };
      }
      if (action.action === "acquire") return extensionAcquire.promise;
      return { room: room(4), lease: null };
    });
    const leaseMany = vi.fn<(action: SemanticLeaseBatchAction) => Promise<SemanticLeaseBatchResult>>();
    const manager = new SemanticLeaseCohortManager(managerOptions({ lease, leaseMany }));
    await manager.ensureCohort({ cohortId: "early-release", targets: [target("a")] });
    const extension = manager.ensureCohort({
      cohortId: "early-release",
      targets: [target("a"), target("b")],
    }).catch((error: unknown) => error);

    const release = manager.releaseCohort("early-release");
    extensionAcquire.resolve({ room: room(2), lease: objectLease("b") });
    const extensionResult = await extension;
    await release;

    expect(extensionResult).toMatchObject({ code: "INACTIVE_COHORT" });
    expect(manager.hasCohort("early-release")).toBe(false);
    expect(manager.getOwnedLease("a")).toBeNull();
    expect(manager.getOwnedLease("b")).toBeNull();
    await expect(manager.ensureCohort({
      cohortId: "early-release",
      targets: [target("a")],
    })).rejects.toMatchObject({ code: "INACTIVE_COHORT" });
  });

  it("bounds retired gesture fencing with deterministic FIFO eviction", async () => {
    const lease = vi.fn(async (action: SemanticLeaseAction) => {
      if (action.action === "acquire") {
        return { room: room(1), lease: objectLease(action.objectId) };
      }
      return { room: room(2), lease: null };
    });
    const leaseMany = vi.fn<(action: SemanticLeaseBatchAction) => Promise<SemanticLeaseBatchResult>>();
    const manager = new SemanticLeaseCohortManager({
      ...managerOptions({ lease, leaseMany }),
      retiredCohortCapacity: 2,
    });

    for (const cohortId of ["oldest", "middle", "newest"]) {
      await manager.ensureCohort({ cohortId, targets: [target(cohortId)] });
      await manager.releaseCohort(cohortId);
    }

    await expect(manager.ensureCohort({
      cohortId: "middle",
      targets: [target("middle")],
    })).rejects.toMatchObject({ code: "INACTIVE_COHORT" });
    await manager.ensureCohort({ cohortId: "oldest", targets: [target("oldest")] });
    expect(manager.hasCohort("oldest")).toBe(true);
    await manager.releaseCohort("oldest");
  });

  it("releases an acquisition that resolves after its cohort was explicitly released", async () => {
    const coordinator = new CanvasObjectSyncCoordinator();
    const acquire = deferred<SemanticLeaseResult>();
    const lease = vi.fn(async (action: SemanticLeaseAction) => {
      if (action.action === "acquire") return acquire.promise;
      return { room: room(2), lease: null };
    });
    const leaseMany = vi.fn<(action: SemanticLeaseBatchAction) => Promise<SemanticLeaseBatchResult>>();
    const manager = new SemanticLeaseCohortManager(managerOptions({
      coordinator,
      lease,
      leaseMany,
    }));

    const acquisition = manager
      .acquireCohort({ cohortId: "released-early", targets: [target("a")] })
      .catch((error: unknown) => error);
    const release = manager.releaseCohort("released-early");
    expect(coordinator.get("a")?.leaseRequest).not.toBeNull();

    acquire.resolve({ room: room(1), lease: objectLease("a") });
    const outcome = await acquisition;
    await release;

    expect(outcome).toBeInstanceOf(SemanticLeaseManagerError);
    expect((outcome as SemanticLeaseManagerError).code).toBe("INACTIVE_COHORT");
    expect(lease.mock.calls.map(([action]) => action.action)).toEqual(["acquire", "release"]);
    expect(coordinator.get("a")?.lease ?? null).toBeNull();
  });

  it("retains lease identity after an ambiguous renewal failure and retries next tick", async () => {
    vi.useFakeTimers();
    let renewAttempts = 0;
    const lease = vi.fn(async (action: SemanticLeaseAction) => {
      if (action.action === "acquire") {
        return { room: room(1), lease: objectLease(action.objectId) };
      }
      if (action.action === "renew") {
        renewAttempts += 1;
        if (renewAttempts === 1) throw new Error("network unavailable");
        return { room: room(2), lease: objectLease(action.objectId, 1, 8_000) };
      }
      return { room: room(3), lease: null };
    });
    const leaseMany = vi.fn<(action: SemanticLeaseBatchAction) => Promise<SemanticLeaseBatchResult>>();
    const manager = new SemanticLeaseCohortManager(managerOptions({ lease, leaseMany }));
    await manager.acquireCohort({ cohortId: "move", targets: [target("a")] });

    await vi.advanceTimersByTimeAsync(SEMANTIC_LEASE_RENEWAL_INTERVAL_MS);
    expect(manager.getOwnedLease("a")?.leaseId).toBe("lease-a");
    expect(manager.getOwnedLease("a")?.expiresAt).toBe(5_000);

    await vi.advanceTimersByTimeAsync(SEMANTIC_LEASE_RENEWAL_INTERVAL_MS);
    expect(renewAttempts).toBe(2);
    expect(manager.getOwnedLease("a")?.expiresAt).toBe(8_000);
    await manager.releaseCohort("move");
  });

  it("probes siblings after a definitive batch-renew failure and recovers every affected cohort", async () => {
    vi.useFakeTimers();
    const stale = staleLeaseError();
    const recoveries = vi.fn<SemanticLeaseCohortManagerOptions["onCohortRecovery"]>();
    const lease = vi.fn(async (action: SemanticLeaseAction) => {
      if (action.action === "renew" && action.objectId === "a") {
        return { room: room(3), lease: objectLease("a", 1, 8_000) };
      }
      if (action.action === "renew") throw stale;
      if (action.action === "release") return { room: room(4), lease: null };
      throw new Error(`Unexpected ${action.action}`);
    });
    const leaseMany = vi.fn(async (action: SemanticLeaseBatchAction) => {
      if (action.action === "acquire-many") {
        return { room: room(1), leases: [objectLease("a"), objectLease("b")] };
      }
      if (action.action === "renew-many") throw stale;
      return { room: room(5), leases: [] };
    });
    const manager = new SemanticLeaseCohortManager(managerOptions({
      lease,
      leaseMany,
      onCohortRecovery: recoveries,
    }));
    await manager.acquireCohort({
      cohortId: "diagram-move",
      targets: [target("a"), target("b")],
    });

    await vi.advanceTimersByTimeAsync(SEMANTIC_LEASE_RENEWAL_INTERVAL_MS);

    expect(leaseMany).toHaveBeenCalledWith({
      action: "renew-many",
      targets: [
        { objectId: "a", leaseId: "lease-a" },
        { objectId: "b", leaseId: "lease-b" },
      ],
    });
    expect(lease.mock.calls.filter(([action]) => action.action === "renew")).toHaveLength(2);
    expect(manager.getOwnedLease("a")?.expiresAt).toBe(8_000);
    expect(manager.getOwnedLease("b")).toBeNull();
    expect(recoveries).toHaveBeenCalledWith({
      cohortId: "diagram-move",
      objectIds: ["a", "b"],
      lostObjectIds: ["b"],
      cause: stale,
    });

    const renewCount = leaseMany.mock.calls.filter(([action]) => action.action === "renew-many").length;
    await vi.advanceTimersByTimeAsync(SEMANTIC_LEASE_RENEWAL_INTERVAL_MS * 2);
    expect(leaseMany.mock.calls.filter(([action]) => action.action === "renew-many")).toHaveLength(
      renewCount,
    );
    await manager.releaseCohort("diagram-move");
  });

  it("allows the recovery callback to explicitly release its cohort without waiting on itself", async () => {
    vi.useFakeTimers();
    const stale = staleLeaseError();
    const recoveredIds: string[] = [];
    const lease = vi.fn(async (action: SemanticLeaseAction) => {
      if (action.action === "renew" && action.objectId === "a") {
        return { room: room(2), lease: objectLease("a", 1, 8_000) };
      }
      if (action.action === "renew") throw stale;
      if (action.action === "release") return { room: room(3), lease: null };
      throw new Error(`Unexpected ${action.action}`);
    });
    const leaseMany = vi.fn(async (action: SemanticLeaseBatchAction) => {
      if (action.action === "acquire-many") {
        return { room: room(1), leases: [objectLease("a"), objectLease("b")] };
      }
      if (action.action === "renew-many") throw stale;
      return { room: room(4), leases: [] };
    });
    const manager = new SemanticLeaseCohortManager(managerOptions({
      lease,
      leaseMany,
      onCohortRecovery: async (recovery) => {
        recoveredIds.push(...recovery.objectIds);
        await manager.releaseCohort(recovery.cohortId);
      },
    }));
    await manager.acquireCohort({
      cohortId: "recover-and-release",
      targets: [target("a"), target("b")],
    });

    await vi.advanceTimersByTimeAsync(SEMANTIC_LEASE_RENEWAL_INTERVAL_MS);

    expect(recoveredIds).toEqual(["a", "b"]);
    expect(manager.hasCohort("recover-and-release")).toBe(false);
    expect(manager.getOwnedLease("a")).toBeNull();
    expect(manager.getOwnedLease("b")).toBeNull();
  });

  it("falls back to individual releases only for a definitive stale batch member", async () => {
    const stale = staleLeaseError();
    const lease = vi.fn(async (action: SemanticLeaseAction) => {
      if (action.action !== "release") throw new Error(`Unexpected ${action.action}`);
      return { room: room(action.objectId === "a" ? 3 : 4), lease: null };
    });
    const leaseMany = vi.fn(async (action: SemanticLeaseBatchAction) => {
      if (action.action === "acquire-many") {
        return { room: room(1), leases: [objectLease("a"), objectLease("b")] };
      }
      if (action.action === "release-many") throw stale;
      throw new Error(`Unexpected ${action.action}`);
    });
    const manager = new SemanticLeaseCohortManager(managerOptions({ lease, leaseMany }));
    await manager.acquireCohort({
      cohortId: "batch",
      targets: [target("a"), target("b")],
    });

    await manager.releaseCohort("batch");

    expect(leaseMany).toHaveBeenCalledWith({
      action: "release-many",
      targets: [
        { objectId: "a", leaseId: "lease-a" },
        { objectId: "b", leaseId: "lease-b" },
      ],
    });
    expect(lease.mock.calls.map(([action]) => action)).toEqual([
      { action: "release", objectId: "a", leaseId: "lease-a" },
      { action: "release", objectId: "b", leaseId: "lease-b" },
    ]);
    expect(manager.getOwnedLease("a")).toBeNull();
    expect(manager.getOwnedLease("b")).toBeNull();
  });

  it("fences callbacks, cancels renewals, releases known leases, and releases late acquisitions on dispose", async () => {
    vi.useFakeTimers();
    const lateAcquire = deferred<SemanticLeaseResult>();
    const acceptedRooms: number[] = [];
    const recoveries = vi.fn<SemanticLeaseCohortManagerOptions["onCohortRecovery"]>();
    const lease = vi.fn(async (action: SemanticLeaseAction) => {
      if (action.action === "acquire" && action.objectId === "a") {
        return { room: room(1), lease: objectLease("a") };
      }
      if (action.action === "acquire") return lateAcquire.promise;
      if (action.action === "renew") {
        return { room: room(9), lease: objectLease(action.objectId, 1, 8_000) };
      }
      return { room: room(10), lease: null };
    });
    const leaseMany = vi.fn<(action: SemanticLeaseBatchAction) => Promise<SemanticLeaseBatchResult>>();
    const manager = new SemanticLeaseCohortManager(managerOptions({
      lease,
      leaseMany,
      onRoom: (next) => acceptedRooms.push(next.stateRevision ?? -1),
      onCohortRecovery: recoveries,
    }));
    await manager.acquireCohort({ cohortId: "known", targets: [target("a")] });
    const lateOutcome = manager
      .acquireCohort({ cohortId: "late", targets: [target("b")] })
      .catch((error: unknown) => error);

    await manager.dispose();
    expect(lease.mock.calls.some(([action]) =>
      action.action === "release" && action.objectId === "a"
    )).toBe(true);
    await vi.advanceTimersByTimeAsync(SEMANTIC_LEASE_RENEWAL_INTERVAL_MS * 3);
    expect(lease.mock.calls.some(([action]) => action.action === "renew")).toBe(false);

    lateAcquire.resolve({ room: room(20), lease: objectLease("b") });
    const lateResult = await lateOutcome;
    await vi.waitFor(() => expect(lease.mock.calls.some(([action]) =>
      action.action === "release" && action.objectId === "b"
    )).toBe(true));

    expect(lateResult).toBeInstanceOf(SemanticLeaseManagerError);
    expect((lateResult as SemanticLeaseManagerError).code).toBe("DISPOSED");
    expect(acceptedRooms).toEqual([1]);
    expect(recoveries).not.toHaveBeenCalled();
  });
});
