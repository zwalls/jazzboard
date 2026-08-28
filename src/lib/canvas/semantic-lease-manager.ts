import type { CanvasObjectSyncCoordinator } from "./sync-coordinator";
import type {
  ObjectLease,
  ObjectLeaseAcquireTarget,
  ObjectLeaseTokenTarget,
  RoomState,
} from "@/lib/domain/types";

/** Jazzboard leases last four seconds; renewing well before the midpoint leaves recovery margin. */
export const SEMANTIC_LEASE_RENEWAL_INTERVAL_MS = 1_500;
export const SEMANTIC_RETIRED_COHORT_CAPACITY = 2_048;

export type SemanticLeaseAction =
  | ({ action: "acquire" } & ObjectLeaseAcquireTarget)
  | ({ action: "renew" | "release" } & ObjectLeaseTokenTarget);

export type SemanticLeaseBatchAction =
  | { action: "acquire-many"; targets: ObjectLeaseAcquireTarget[] }
  | { action: "renew-many" | "release-many"; targets: ObjectLeaseTokenTarget[] };

export type SemanticLeaseResult = Readonly<{
  lease: ObjectLease | null;
  room: RoomState;
}>;

export type SemanticLeaseBatchResult = Readonly<{
  leases: readonly ObjectLease[];
  room: RoomState;
}>;

export type SemanticLeaseCohortRecovery = Readonly<{
  cohortId: string;
  /** Every object in the atomic edit, not only the member with the stale token. */
  objectIds: readonly string[];
  lostObjectIds: readonly string[];
  cause: unknown;
}>;

export type SemanticLeaseCohortSnapshot = Readonly<{
  cohortId: string;
  objectIds: readonly string[];
  leases: ReadonlyMap<string, ObjectLease>;
}>;

export type SemanticLeaseCohortManagerOptions = Readonly<{
  coordinator: CanvasObjectSyncCoordinator;
  lease: (action: SemanticLeaseAction) => Promise<SemanticLeaseResult>;
  leaseMany: (action: SemanticLeaseBatchAction) => Promise<SemanticLeaseBatchResult>;
  /** Lets the persistence host monotonically accept coordination revisions. */
  onRoom: (room: RoomState) => void;
  /** Must return true only for a definitive missing or stale lease token. */
  isLeaseNotFound: (error: unknown) => boolean;
  /** A lost member invalidates the whole semantic gesture. */
  onCohortRecovery: (recovery: SemanticLeaseCohortRecovery) => void | Promise<void>;
  renewalIntervalMs?: number;
  retiredCohortCapacity?: number;
  scheduleInterval?: (callback: () => void, milliseconds: number) => unknown;
  cancelInterval?: (handle: unknown) => void;
}>;

export class SemanticLeaseManagerError extends Error {
  constructor(
    readonly code:
      | "DISPOSED"
      | "DUPLICATE_COHORT"
      | "DUPLICATE_OBJECT"
      | "EMPTY_COHORT"
      | "INACTIVE_COHORT"
      | "CONFLICTING_TARGET"
      | "INVALID_RESPONSE",
    message: string,
  ) {
    super(message);
    this.name = "SemanticLeaseManagerError";
  }
}

type CohortState = "acquiring" | "active" | "recovering" | "releasing" | "released";

type LeaseCohort = {
  id: string;
  targets: Map<string, ObjectLeaseAcquireTarget>;
  state: CohortState;
  timer: unknown | null;
  acquireRequest: Promise<SemanticLeaseCohortSnapshot> | null;
  renewalRequest: Promise<void> | null;
  releaseRequest: Promise<void> | null;
};

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function tokenTarget(lease: ObjectLease): ObjectLeaseTokenTarget {
  return { objectId: lease.objectId, leaseId: lease.leaseId };
}

/**
 * Owns lease acquisition, renewal, overlap, and release for semantic editing.
 *
 * A caller should use its gesture/session ID as `cohortId`, await
 * `acquireCohort`, attach the returned tokens to its atomic command, and call
 * `releaseCohort` only after acknowledgement or authoritative recovery.
 * Canvas pixels and commands deliberately remain outside this class.
 */
export class SemanticLeaseCohortManager {
  private readonly coordinator: CanvasObjectSyncCoordinator;
  private readonly leaseTransport: SemanticLeaseCohortManagerOptions["lease"];
  private readonly leaseManyTransport: SemanticLeaseCohortManagerOptions["leaseMany"];
  private readonly onRoom: SemanticLeaseCohortManagerOptions["onRoom"];
  private readonly isLeaseNotFound: SemanticLeaseCohortManagerOptions["isLeaseNotFound"];
  private readonly onCohortRecovery: SemanticLeaseCohortManagerOptions["onCohortRecovery"];
  private readonly renewalIntervalMs: number;
  private readonly retiredCohortCapacity: number;
  private readonly scheduleInterval: NonNullable<
    SemanticLeaseCohortManagerOptions["scheduleInterval"]
  >;
  private readonly cancelInterval: NonNullable<
    SemanticLeaseCohortManagerOptions["cancelInterval"]
  >;
  private readonly cohorts = new Map<string, LeaseCohort>();
  /** Prevents a late frame from resurrecting a gesture after release. */
  private readonly retiredCohortIds = new Set<string>();
  private readonly cohortIdsByObject = new Map<string, Set<string>>();
  private readonly acquisitionByObject = new Map<string, Promise<ObjectLease | null>>();
  private disposed = false;
  private disposeRequest: Promise<void> | null = null;

  constructor(options: SemanticLeaseCohortManagerOptions) {
    this.coordinator = options.coordinator;
    this.leaseTransport = options.lease;
    this.leaseManyTransport = options.leaseMany;
    this.onRoom = options.onRoom;
    this.isLeaseNotFound = options.isLeaseNotFound;
    this.onCohortRecovery = options.onCohortRecovery;
    this.renewalIntervalMs =
      options.renewalIntervalMs ?? SEMANTIC_LEASE_RENEWAL_INTERVAL_MS;
    this.retiredCohortCapacity = Math.max(
      1,
      Math.floor(options.retiredCohortCapacity ?? SEMANTIC_RETIRED_COHORT_CAPACITY),
    );
    this.scheduleInterval =
      options.scheduleInterval ??
      ((callback, milliseconds) => globalThis.setInterval(callback, milliseconds));
    this.cancelInterval =
      options.cancelInterval ?? ((handle) => globalThis.clearInterval(handle as number));
  }

  acquireCohort(input: Readonly<{
    cohortId: string;
    targets: readonly ObjectLeaseAcquireTarget[];
  }>): Promise<SemanticLeaseCohortSnapshot> {
    if (this.disposed) {
      return Promise.reject(
        new SemanticLeaseManagerError("DISPOSED", "The semantic lease manager is disposed."),
      );
    }
    if (!input.targets.length) {
      return Promise.reject(
        new SemanticLeaseManagerError("EMPTY_COHORT", "A lease cohort requires at least one object."),
      );
    }
    if (this.cohorts.has(input.cohortId)) {
      return Promise.reject(
        new SemanticLeaseManagerError(
          "DUPLICATE_COHORT",
          `Lease cohort ${input.cohortId} already exists.`,
        ),
      );
    }
    if (this.retiredCohortIds.has(input.cohortId)) {
      return Promise.reject(
        new SemanticLeaseManagerError(
          "INACTIVE_COHORT",
          `Lease cohort ${input.cohortId} has already been released.`,
        ),
      );
    }

    const targets = new Map<string, ObjectLeaseAcquireTarget>();
    for (const target of input.targets) {
      if (targets.has(target.objectId)) {
        return Promise.reject(
          new SemanticLeaseManagerError(
            "DUPLICATE_OBJECT",
            `Lease cohort ${input.cohortId} contains object ${target.objectId} more than once.`,
          ),
        );
      }
      targets.set(target.objectId, { ...target });
    }

    const cohort: LeaseCohort = {
      id: input.cohortId,
      targets,
      state: "acquiring",
      timer: null,
      acquireRequest: null,
      renewalRequest: null,
      releaseRequest: null,
    };
    this.cohorts.set(cohort.id, cohort);
    for (const target of targets.values()) {
      this.coordinator.getOrCreate(target.objectId, target.expectedRevision);
      this.addReference(cohort.id, target.objectId);
    }

    const request = this.startEnsuring(cohort).catch(async (error: unknown) => {
      if (this.cohorts.get(cohort.id) === cohort && cohort.state === "acquiring") {
        cohort.state = "released";
        const unreferenced = this.detachReferences(cohort);
        this.retireCohortId(cohort.id);
        this.cohorts.delete(cohort.id);
        await this.releaseUnreferenced(unreferenced);
      }
      throw error;
    });
    return request;
  }

  /**
   * Creates a cohort when absent or extends an acquiring/active cohort with
   * newly discovered members. This is the frame-safe API for semantic hosts:
   * repeated identical discoveries are idempotent, while changing an existing
   * member's revision or operation is a fenced programming error.
   */
  ensureCohort(input: Readonly<{
    cohortId: string;
    targets: readonly ObjectLeaseAcquireTarget[];
  }>): Promise<SemanticLeaseCohortSnapshot> {
    if (this.disposed) {
      return Promise.reject(
        new SemanticLeaseManagerError("DISPOSED", "The semantic lease manager is disposed."),
      );
    }

    const normalized = new Map<string, ObjectLeaseAcquireTarget>();
    for (const target of input.targets) {
      const duplicate = normalized.get(target.objectId);
      if (
        duplicate &&
        (duplicate.expectedRevision !== target.expectedRevision ||
          duplicate.operation !== target.operation)
      ) {
        return Promise.reject(this.conflictingTargetError(input.cohortId, target.objectId));
      }
      normalized.set(target.objectId, { ...target });
    }
    if (!normalized.size) {
      return Promise.reject(
        new SemanticLeaseManagerError("EMPTY_COHORT", "A lease cohort requires at least one object."),
      );
    }

    const cohort = this.cohorts.get(input.cohortId);
    if (!cohort) {
      if (this.retiredCohortIds.has(input.cohortId)) {
        return Promise.reject(
          new SemanticLeaseManagerError(
            "INACTIVE_COHORT",
            `Lease cohort ${input.cohortId} has already been released.`,
          ),
        );
      }
      return this.acquireCohort({ cohortId: input.cohortId, targets: [...normalized.values()] });
    }
    if (cohort.state !== "acquiring" && cohort.state !== "active") {
      return Promise.reject(
        new SemanticLeaseManagerError(
          "INACTIVE_COHORT",
          `Lease cohort ${input.cohortId} cannot be extended while ${cohort.state}.`,
        ),
      );
    }

    for (const target of normalized.values()) {
      const existing = cohort.targets.get(target.objectId);
      if (existing) {
        if (
          existing.expectedRevision !== target.expectedRevision ||
          existing.operation !== target.operation
        ) {
          return Promise.reject(this.conflictingTargetError(cohort.id, target.objectId));
        }
        continue;
      }
      cohort.targets.set(target.objectId, target);
      this.coordinator.getOrCreate(target.objectId, target.expectedRevision);
      this.addReference(cohort.id, target.objectId);
    }

    return this.startEnsuring(cohort);
  }

  /** Returns how many live edit cohorts currently depend on an object lease. */
  referenceCount(objectId: string): number {
    return this.cohortIdsByObject.get(objectId)?.size ?? 0;
  }

  hasCohort(cohortId: string): boolean {
    const state = this.cohorts.get(cohortId)?.state;
    return state !== undefined && state !== "released";
  }

  getOwnedLease(objectId: string): ObjectLease | null {
    return this.coordinator.get(objectId)?.lease?.lease ?? null;
  }

  /**
   * Drops one caller reference. An object is released only after its final
   * overlapping cohort has explicitly released it.
   */
  releaseCohort(cohortId: string): Promise<void> {
    const cohort = this.cohorts.get(cohortId);
    if (!cohort) return Promise.resolve();
    if (cohort.releaseRequest) return cohort.releaseRequest;
    if (cohort.state === "released") return Promise.resolve();

    cohort.state = "releasing";
    this.stopRenewal(cohort);
    const unreferenced = this.detachReferences(cohort);
    const pending = new Set<Promise<unknown>>();
    for (const objectId of cohort.targets.keys()) {
      const acquire = this.acquisitionByObject.get(objectId);
      if (acquire) pending.add(acquire);
    }

    const request = Promise.allSettled([...pending])
      .then(async () => {
        await Promise.allSettled(this.refreshRemainingOperations(cohort.targets.keys()));
        await this.releaseUnreferenced(unreferenced);
      })
      .finally(() => {
        cohort.state = "released";
        cohort.releaseRequest = null;
        this.retireCohortId(cohort.id);
        this.cohorts.delete(cohort.id);
      });
    cohort.releaseRequest = request;
    return request;
  }

  /**
   * Synchronously fences callbacks and timers, then best-effort releases every
   * currently known lease. Acquires that resolve later observe the fence and
   * release their returned tokens without touching host state.
   */
  dispose(): Promise<void> {
    if (this.disposeRequest) return this.disposeRequest;
    this.disposed = true;

    const objectIds = new Set<string>();
    for (const cohort of this.cohorts.values()) {
      cohort.state = "released";
      this.stopRenewal(cohort);
      this.retireCohortId(cohort.id);
      for (const objectId of cohort.targets.keys()) objectIds.add(objectId);
    }
    this.cohorts.clear();
    this.cohortIdsByObject.clear();
    this.coordinator.forEach((entry) => {
      if (entry.lease) objectIds.add(entry.objectId);
      this.coordinator.cancelLeaseIntent(entry.objectId);
    });

    const request = this.releaseUnreferenced(objectIds).catch(() => undefined);
    this.disposeRequest = request;
    return request;
  }

  private startEnsuring(cohort: LeaseCohort): Promise<SemanticLeaseCohortSnapshot> {
    if (cohort.acquireRequest) return cohort.acquireRequest;
    const request = this.finishEnsuring(cohort);
    cohort.acquireRequest = request;
    const clearRequest = () => {
      if (cohort.acquireRequest === request) cohort.acquireRequest = null;
    };
    void request.then(clearRequest, clearRequest);
    return request;
  }

  private async finishEnsuring(cohort: LeaseCohort): Promise<SemanticLeaseCohortSnapshot> {
    while (this.isEnsureable(cohort)) {
      const blockers = new Set<Promise<unknown>>();
      const missing: ObjectLeaseAcquireTarget[] = [];

      for (const target of cohort.targets.values()) {
        const entry = this.coordinator.getOrCreate(target.objectId, target.expectedRevision);
        if (entry.releaseRequest) blockers.add(entry.releaseRequest);
        const pending = this.acquisitionByObject.get(target.objectId);
        if (pending) blockers.add(pending);
        const desired = this.desiredTarget(target.objectId) ?? target;
        if (
          (!entry.lease || entry.lease.lease.operation !== desired.operation) &&
          !entry.releaseRequest &&
          !pending
        ) {
          missing.push(desired);
        }
      }

      if (blockers.size) {
        await Promise.all([...blockers]);
        continue;
      }
      if (missing.length) {
        await this.acquireMissing(missing);
        continue;
      }

      const leases = new Map<string, ObjectLease>();
      for (const objectId of cohort.targets.keys()) {
        const lease = this.coordinator.get(objectId)?.lease?.lease;
        if (!lease) {
          throw new SemanticLeaseManagerError(
            "INVALID_RESPONSE",
            `No owned lease is available for object ${objectId}.`,
          );
        }
        leases.set(objectId, lease);
      }
      cohort.state = "active";
      this.startRenewal(cohort);
      return {
        cohortId: cohort.id,
        objectIds: Object.freeze([...cohort.targets.keys()]),
        leases,
      };
    }

    throw new SemanticLeaseManagerError(
      this.disposed ? "DISPOSED" : "INACTIVE_COHORT",
      this.disposed
        ? "The semantic lease manager was disposed while acquiring a cohort."
        : `Lease cohort ${cohort.id} was released before acquisition completed.`,
    );
  }

  private async acquireMissing(targets: readonly ObjectLeaseAcquireTarget[]): Promise<void> {
    const batchRequest = this.requestAcquire(targets);
    const perObject = new Map<
      string,
      {
        request: Promise<ObjectLease | null>;
        barrier: Promise<ObjectLease | null>;
      }
    >();
    for (const target of targets) {
      const request = batchRequest.then((leases) => leases.get(target.objectId) ?? null);
      // The barrier stored on the coordinator intentionally resolves to null on
      // failure; the owning cohort awaits batchRequest and propagates it once.
      const barrier = request.catch(() => null);
      perObject.set(target.objectId, { request, barrier });
      this.acquisitionByObject.set(target.objectId, request);
      this.coordinator.getOrCreate(target.objectId, target.expectedRevision).leaseRequest = barrier;
    }

    try {
      await batchRequest;
    } finally {
      for (const [objectId, requests] of perObject) {
        const { request, barrier } = requests;
        if (this.acquisitionByObject.get(objectId) === request) {
          this.acquisitionByObject.delete(objectId);
        }
        const entry = this.coordinator.get(objectId);
        if (entry?.leaseRequest === barrier) entry.leaseRequest = null;
      }
    }
  }

  private async requestAcquire(
    targets: readonly ObjectLeaseAcquireTarget[],
  ): Promise<Map<string, ObjectLease>> {
    const result =
      targets.length === 1
        ? await this.leaseTransport({ action: "acquire", ...targets[0] }).then((single) => ({
            room: single.room,
            leases: single.lease ? [single.lease] : [],
          }))
        : await this.leaseManyTransport({ action: "acquire-many", targets: [...targets] });
    let leases: Map<string, ObjectLease>;
    try {
      leases = this.validateLeaseResponse("acquire", targets, result.leases);
    } catch (error) {
      void this.releaseRaw(result.leases);
      throw error;
    }

    if (this.disposed) {
      void this.releaseRaw([...leases.values()]);
      return leases;
    }

    const referencedIds = targets
      .map((target) => target.objectId)
      .filter((objectId) => this.referenceCount(objectId) > 0);
    if (referencedIds.length) this.emitRoom(result.room);

    const unreferenced: string[] = [];
    for (const lease of leases.values()) {
      const entry = this.coordinator.getOrCreate(lease.objectId, lease.objectRevision);
      entry.lease = { lease, renewTimer: null };
      if (this.referenceCount(lease.objectId) === 0) unreferenced.push(lease.objectId);
    }
    if (unreferenced.length) void this.releaseUnreferenced(unreferenced);
    return leases;
  }

  private startRenewal(cohort: LeaseCohort): void {
    if (this.disposed || cohort.state !== "active" || cohort.timer !== null) return;
    cohort.timer = this.scheduleInterval(() => {
      if (cohort.renewalRequest || !this.isActive(cohort)) return;
      const request = this.renewCohort(cohort).finally(() => {
        if (cohort.renewalRequest === request) cohort.renewalRequest = null;
      });
      cohort.renewalRequest = request;
      void request;
    }, this.renewalIntervalMs);
  }

  private stopRenewal(cohort: LeaseCohort): void {
    if (cohort.timer === null) return;
    this.cancelInterval(cohort.timer);
    cohort.timer = null;
  }

  private async renewCohort(cohort: LeaseCohort): Promise<void> {
    if (!this.isActive(cohort)) return;
    const targets: ObjectLeaseTokenTarget[] = [];
    const missing: string[] = [];
    for (const objectId of cohort.targets.keys()) {
      if (this.acquisitionByObject.has(objectId)) continue;
      const lease = this.coordinator.get(objectId)?.lease?.lease;
      if (lease) targets.push(tokenTarget(lease));
      else if (!this.acquisitionByObject.has(objectId) && !cohort.acquireRequest) {
        missing.push(objectId);
      }
    }
    if (missing.length) {
      await this.recoverEveryAffectedCohort(missing, new SemanticLeaseManagerError(
        "INVALID_RESPONSE",
        `Lease ownership disappeared for ${missing.join(", ")}.`,
      ));
      return;
    }
    if (!targets.length) return;

    try {
      const result =
        targets.length === 1
          ? await this.leaseTransport({ action: "renew", ...targets[0] }).then((single) => ({
              room: single.room,
              leases: single.lease ? [single.lease] : [],
            }))
          : await this.leaseManyTransport({ action: "renew-many", targets: [...targets] });
      const renewed = this.validateLeaseResponse("renew", targets, result.leases);
      if (!this.isActive(cohort)) return;
      this.emitRoom(result.room);
      this.installRenewed(targets, renewed);
    } catch (error) {
      if (
        error instanceof SemanticLeaseManagerError &&
        error.code === "INVALID_RESPONSE" &&
        this.isActive(cohort)
      ) {
        await this.triggerRecovery(
          cohort,
          targets.map((target) => target.objectId),
          error,
        );
        return;
      }
      // An ordinary network failure has an unknowable commit outcome. Keep the
      // exact identities and let the next 1.5 second tick reconcile them.
      if (!this.isLeaseNotFound(error) || !this.isActive(cohort)) return;
      await this.probeAfterDefinitiveRenewalFailure(cohort, targets, error);
    }
  }

  private async probeAfterDefinitiveRenewalFailure(
    cohort: LeaseCohort,
    targets: readonly ObjectLeaseTokenTarget[],
    batchError: unknown,
  ): Promise<void> {
    const lost: string[] = [];
    for (const target of targets) {
      if (!this.isActive(cohort)) return;
      try {
        const result = await this.leaseTransport({ action: "renew", ...target });
        if (!this.isActive(cohort)) return;
        if (!result.lease || result.lease.objectId !== target.objectId) {
          lost.push(target.objectId);
          continue;
        }
        this.emitRoom(result.room);
        this.installRenewed([target], new Map([[target.objectId, result.lease]]));
      } catch (error) {
        if (this.isLeaseNotFound(error)) lost.push(target.objectId);
        // Ambiguous sibling failures remain installed and are retried on a
        // future tick unless another sibling proved the cohort invalid.
      }
    }
    if (!lost.length || !this.isActive(cohort)) return;

    for (const objectId of lost) {
      const entry = this.coordinator.get(objectId);
      const expected = targets.find((target) => target.objectId === objectId);
      if (entry?.lease && expected && entry.lease.lease.leaseId === expected.leaseId) {
        entry.lease = null;
      }
    }
    await this.recoverEveryAffectedCohort(lost, batchError);
  }

  private installRenewed(
    targets: readonly ObjectLeaseTokenTarget[],
    renewed: ReadonlyMap<string, ObjectLease>,
  ): void {
    for (const target of targets) {
      const entry = this.coordinator.get(target.objectId);
      const next = renewed.get(target.objectId);
      if (
        entry?.lease &&
        next &&
        entry.lease.lease.leaseId === target.leaseId &&
        next.leaseId === target.leaseId &&
        this.referenceCount(target.objectId) > 0
      ) {
        entry.lease.lease = next;
      }
    }
  }

  private async recoverEveryAffectedCohort(
    lostObjectIds: readonly string[],
    cause: unknown,
  ): Promise<void> {
    const affected = new Set<LeaseCohort>();
    for (const objectId of lostObjectIds) {
      for (const cohortId of this.cohortIdsByObject.get(objectId) ?? []) {
        const cohort = this.cohorts.get(cohortId);
        if (cohort && this.isActive(cohort)) affected.add(cohort);
      }
    }
    await Promise.all([...affected].map((cohort) => this.triggerRecovery(
      cohort,
      lostObjectIds.filter((objectId) => cohort.targets.has(objectId)),
      cause,
    )));
  }

  private async triggerRecovery(
    cohort: LeaseCohort,
    lostObjectIds: readonly string[],
    cause: unknown,
  ): Promise<void> {
    if (!this.isActive(cohort)) return;
    cohort.state = "recovering";
    this.stopRenewal(cohort);
    if (this.disposed) return;
    try {
      await this.onCohortRecovery({
        cohortId: cohort.id,
        objectIds: Object.freeze([...cohort.targets.keys()]),
        lostObjectIds: Object.freeze(sortedUnique(lostObjectIds)),
        cause,
      });
    } catch {
      // Host recovery errors are handled by its authoritative retry loop. The
      // manager remains fenced and never resumes a cohort with a lost member.
    }
  }

  private async releaseUnreferenced(objectIds: Iterable<string>): Promise<void> {
    const uniqueIds = sortedUnique(objectIds);
    const existingRequests = new Set<Promise<void>>();
    for (const objectId of uniqueIds) {
      const entry = this.coordinator.get(objectId);
      if (entry?.releaseRequest) existingRequests.add(entry.releaseRequest);
    }
    if (existingRequests.size) await Promise.allSettled([...existingRequests]);

    const active = uniqueIds.flatMap((objectId) => {
      if (this.referenceCount(objectId) > 0) return [];
      const entry = this.coordinator.get(objectId);
      if (!entry?.lease || entry.releaseRequest) return [];
      this.coordinator.cancelLeaseIntent(objectId);
      return [{ entry, lease: entry.lease.lease }];
    });
    if (!active.length) return;

    const targets = active.map(({ lease }) => tokenTarget(lease));
    const request = this.performRelease(targets).finally(() => {
      for (const { entry, lease } of active) {
        if (entry.lease?.lease.leaseId === lease.leaseId) entry.lease = null;
        if (entry.releaseRequest === request) entry.releaseRequest = null;
        this.coordinator.prune(entry.objectId);
      }
    });
    for (const { entry } of active) entry.releaseRequest = request;
    await request;
  }

  private async performRelease(targets: readonly ObjectLeaseTokenTarget[]): Promise<void> {
    try {
      if (targets.length === 1) {
        const result = await this.leaseTransport({ action: "release", ...targets[0] });
        this.emitRoom(result.room);
      } else {
        const result = await this.leaseManyTransport({
          action: "release-many",
          targets: [...targets],
        });
        this.emitRoom(result.room);
      }
    } catch (error) {
      if (targets.length < 2 || !this.isLeaseNotFound(error)) return;
      // The rejected batch changed nothing. Probe each token so valid siblings
      // do not remain locked until expiry; stale members are already harmless.
      for (const target of targets) {
        try {
          const result = await this.leaseTransport({ action: "release", ...target });
          this.emitRoom(result.room);
        } catch {
          // Release is best-effort and leases expire quickly.
        }
      }
    }
  }

  private async releaseRaw(leases: readonly ObjectLease[]): Promise<void> {
    if (!leases.length) return;
    await this.performRelease(leases.map(tokenTarget));
  }

  private validateLeaseResponse(
    operation: "acquire" | "renew",
    targets: readonly (
      | ObjectLeaseAcquireTarget
      | ObjectLeaseTokenTarget
    )[],
    leases: readonly ObjectLease[],
  ): Map<string, ObjectLease> {
    const expected = new Map(targets.map((target) => [target.objectId, target]));
    const result = new Map<string, ObjectLease>();
    for (const lease of leases) {
      const target = expected.get(lease.objectId);
      const mismatchedToken = target && "leaseId" in target && target.leaseId !== lease.leaseId;
      const mismatchedAcquisition =
        target &&
        "expectedRevision" in target &&
        (target.expectedRevision !== lease.objectRevision || target.operation !== lease.operation);
      if (!target || result.has(lease.objectId) || mismatchedToken || mismatchedAcquisition) {
        throw new SemanticLeaseManagerError(
          "INVALID_RESPONSE",
          `The ${operation} response returned an unexpected or duplicate lease.`,
        );
      }
      result.set(lease.objectId, lease);
    }
    if (result.size !== expected.size) {
      throw new SemanticLeaseManagerError(
        "INVALID_RESPONSE",
        `The ${operation} response omitted one or more requested leases.`,
      );
    }
    return result;
  }

  private addReference(cohortId: string, objectId: string): void {
    const references = this.cohortIdsByObject.get(objectId) ?? new Set<string>();
    references.add(cohortId);
    this.cohortIdsByObject.set(objectId, references);
  }

  /** The most recently attached active cohort supplies the human-facing operation label. */
  private desiredTarget(objectId: string): ObjectLeaseAcquireTarget | null {
    const cohortIds = [...(this.cohortIdsByObject.get(objectId) ?? [])];
    for (let index = cohortIds.length - 1; index >= 0; index -= 1) {
      const cohort = this.cohorts.get(cohortIds[index]);
      if (!cohort || (cohort.state !== "acquiring" && cohort.state !== "active")) continue;
      const target = cohort.targets.get(objectId);
      if (target) return target;
    }
    return null;
  }

  private refreshRemainingOperations(objectIds: Iterable<string>): Promise<unknown>[] {
    const cohorts = new Set<LeaseCohort>();
    for (const objectId of objectIds) {
      const desired = this.desiredTarget(objectId);
      if (!desired) continue;
      const owned = this.coordinator.get(objectId)?.lease?.lease;
      if (owned?.operation === desired.operation) continue;
      const cohortIds = [...(this.cohortIdsByObject.get(objectId) ?? [])];
      for (let index = cohortIds.length - 1; index >= 0; index -= 1) {
        const cohort = this.cohorts.get(cohortIds[index]);
        if (cohort && (cohort.state === "acquiring" || cohort.state === "active")) {
          cohorts.add(cohort);
          break;
        }
      }
    }
    return [...cohorts].map((cohort) => this.startEnsuring(cohort));
  }

  private detachReferences(cohort: LeaseCohort): string[] {
    const unreferenced: string[] = [];
    for (const objectId of cohort.targets.keys()) {
      const references = this.cohortIdsByObject.get(objectId);
      references?.delete(cohort.id);
      if (!references?.size) {
        this.cohortIdsByObject.delete(objectId);
        unreferenced.push(objectId);
      }
    }
    return unreferenced;
  }

  private isEnsureable(cohort: LeaseCohort): boolean {
    return (
      !this.disposed &&
      this.cohorts.get(cohort.id) === cohort &&
      (cohort.state === "acquiring" || cohort.state === "active")
    );
  }

  private isActive(cohort: LeaseCohort): boolean {
    return !this.disposed && this.cohorts.get(cohort.id) === cohort && cohort.state === "active";
  }

  private emitRoom(room: RoomState): void {
    if (this.disposed) return;
    try {
      this.onRoom(room);
    } catch {
      // A view callback cannot invalidate server lease ownership.
    }
  }

  private conflictingTargetError(cohortId: string, objectId: string): SemanticLeaseManagerError {
    return new SemanticLeaseManagerError(
      "CONFLICTING_TARGET",
      `Lease cohort ${cohortId} rediscovered object ${objectId} with a different revision or operation.`,
    );
  }

  private retireCohortId(cohortId: string): void {
    // Set insertion order gives us a deterministic, allocation-free FIFO.
    this.retiredCohortIds.delete(cohortId);
    this.retiredCohortIds.add(cohortId);
    while (this.retiredCohortIds.size > this.retiredCohortCapacity) {
      const oldest = this.retiredCohortIds.values().next().value;
      if (oldest === undefined) break;
      this.retiredCohortIds.delete(oldest);
    }
  }
}
