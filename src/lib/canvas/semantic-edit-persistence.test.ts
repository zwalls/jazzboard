import { describe, expect, it } from "vitest";

import { normalizeConnectorRouting } from "@/lib/domain/connector-routing";
import type {
  ActorRef,
  CanvasCommand,
  CanvasObject,
  CreateCanvasObject,
  Diagram,
  ObjectLease,
  ObjectLeaseAcquireTarget,
  RoomState,
  SemanticTransaction,
} from "@/lib/domain/types";

import type { SemanticCanvasEditIntent } from "./semantic-edit-events";
import { SemanticCanvasEditLifecycleController } from "./semantic-edit-lifecycle";
import {
  SEMANTIC_EDIT_DEBOUNCE_MS,
  SEMANTIC_EDIT_RECOVERY_RETRY_MS,
  SemanticCanvasEditPersistenceDriver,
  type SemanticEditPersistenceAcknowledgementEvent,
  type SemanticEditPersistenceClock,
  type SemanticEditPersistenceHost,
  type SemanticEditPersistenceRecoverySettledEvent,
  type SemanticEditPersistenceRollbackEvent,
} from "./semantic-edit-persistence";
import { CanvasObjectSyncCoordinator } from "./sync-coordinator";

const actor: ActorRef = {
  participantId: "participant-1",
  displayName: "Ada",
  color: "#7c3aed",
  kind: "human",
};

type Shape = Extract<CanvasObject, { kind: "shape" }>;
type ShapeDraft = Extract<CreateCanvasObject, { kind: "shape" }>;

function connector(id: string, startObjectId: string, endObjectId: string): CanvasObject {
  return {
    id,
    kind: "connector",
    x: 0,
    y: 0,
    width: 300,
    height: 1,
    rotation: 0,
    zIndex: 3,
    groupId: "group-a",
    diagramIds: [],
    start: { x: 170, y: 65, objectId: startObjectId },
    end: { x: 310, y: 65, objectId: endObjectId },
    routing: normalizeConnectorRouting({ mode: "straight" }),
    direction: "end",
    label: id,
    color: "black",
    revision: 1,
    createdAt: 1_000,
    updatedAt: 1_001,
    createdBy: actor,
    lastEditedBy: actor,
  };
}

function shape(
  id: string,
  revision: number,
  x = 10,
  createdAt = 1_000,
): Shape {
  return {
    id,
    kind: "shape",
    x,
    y: 20,
    width: 160,
    height: 90,
    rotation: 0,
    zIndex: 1,
    groupId: null,
    diagramIds: [],
    shape: "rectangle",
    nodeType: "service",
    nodeMetadata: null,
    label: id,
    fill: "white",
    stroke: "black",
    revision,
    createdAt,
    updatedAt: createdAt + revision,
    createdBy: actor,
    lastEditedBy: actor,
  };
}

function draft(object: Shape, patch: Partial<ShapeDraft> = {}): ShapeDraft {
  return {
    id: object.id,
    kind: "shape",
    x: object.x,
    y: object.y,
    width: object.width,
    height: object.height,
    rotation: object.rotation,
    zIndex: object.zIndex,
    groupId: object.groupId,
    shape: object.shape,
    nodeType: object.nodeType,
    nodeMetadata: object.nodeMetadata,
    label: object.label,
    fill: object.fill,
    stroke: object.stroke,
    ...patch,
  };
}

function roomWith(objects: CanvasObject[], roomRevision = 10): RoomState {
  return {
    id: "room-1",
    code: "1234",
    title: "Persistence test",
    stateRevision: roomRevision,
    roomRevision,
    createdAt: 100,
    updatedAt: 100 + roomRevision,
    participants: {},
    objects: Object.fromEntries(objects.map((object) => [object.id, object])),
    diagrams: {},
    leases: {},
    spotlight: null,
    agentEditPolicy: "live",
    reviewProposals: [],
  };
}

function authoritativeCreate(
  object: CreateCanvasObject,
  revision: number,
  createdAt: number,
): CanvasObject {
  return {
    ...object,
    ...(object.kind === "shape"
      ? { nodeType: object.nodeType ?? null, nodeMetadata: object.nodeMetadata ?? null }
      : {}),
    diagramIds: [],
    revision,
    createdAt,
    updatedAt: createdAt,
    createdBy: actor,
    lastEditedBy: actor,
  } as CanvasObject;
}

function applyCommands(source: RoomState, commands: readonly CanvasCommand[]): RoomState {
  const room = structuredClone(source);
  for (const command of commands) {
    if (command.type === "create") {
      room.objects[command.object.id] = authoritativeCreate(
        command.object,
        1,
        5_000 + room.roomRevision,
      );
      continue;
    }
    if (command.type === "update") {
      const current = room.objects[command.objectId];
      room.objects[command.objectId] = {
        ...current,
        ...command.patch,
        revision: current.revision + 1,
        updatedAt: current.updatedAt + 1,
        lastEditedBy: actor,
      } as CanvasObject;
      continue;
    }
    if (command.type === "delete") {
      for (const target of command.targets) {
        delete room.objects[target.objectId];
        delete room.leases[target.objectId];
      }
      continue;
    }
    if (command.type === "move") {
      for (const target of command.targets) {
        const current = room.objects[target.objectId];
        room.objects[target.objectId] = {
          ...current,
          x: target.x,
          y: target.y,
          revision: current.revision + 1,
          updatedAt: current.updatedAt + 1,
          lastEditedBy: actor,
        };
      }
      continue;
    }
    for (const target of command.targets) {
      const current = room.objects[target.objectId];
      room.objects[target.objectId] = {
        ...current,
        groupId: command.groupId,
        revision: current.revision + 1,
        updatedAt: current.updatedAt + 1,
        lastEditedBy: actor,
      };
    }
  }
  room.roomRevision += 1;
  room.stateRevision = (room.stateRevision ?? room.roomRevision) + 1;
  room.updatedAt += 1;
  return room;
}

class FakeClock implements SemanticEditPersistenceClock {
  private now = 0;
  private nextTimer = 1;
  private readonly timers = new Map<
    number,
    { at: number; callback: () => void }
  >();

  setTimeout(callback: () => void, delayMs: number): number {
    const timer = this.nextTimer++;
    this.timers.set(timer, { at: this.now + delayMs, callback });
    return timer;
  }

  clearTimeout(timer: number): void {
    this.timers.delete(timer);
  }

  advance(delayMs: number): void {
    const end = this.now + delayMs;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, value]) => value.at <= end)
        .sort(
          ([leftId, left], [rightId, right]) =>
            left.at - right.at || leftId - rightId,
        )[0];
      if (!next) break;
      const [timer, value] = next;
      this.timers.delete(timer);
      this.now = value.at;
      value.callback();
    }
    this.now = end;
  }

  get pending(): number {
    return this.timers.size;
  }
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function leaseFor(target: ObjectLeaseAcquireTarget, index = 0): ObjectLease {
  return {
    leaseId: `lease-${target.objectId}-${index}`,
    objectId: target.objectId,
    actor,
    operation: target.operation,
    objectRevision: target.expectedRevision,
    acquiredAt: 1,
    expiresAt: 60_001,
  };
}

class PersistenceHarness {
  room: RoomState;
  readonly ensureCalls: Array<{
    cohortId: string;
    targets: ObjectLeaseAcquireTarget[];
  }> = [];
  readonly releaseCalls: string[] = [];
  readonly commandCalls: CanvasCommand[] = [];
  readonly transactionCalls: SemanticTransaction[] = [];
  readonly acceptedRooms: RoomState[] = [];
  readonly acknowledgements: SemanticEditPersistenceAcknowledgementEvent[] = [];
  readonly rollbacks: SemanticEditPersistenceRollbackEvent[] = [];
  readonly confirmedFailures: unknown[] = [];
  readonly recoverySettlements: SemanticEditPersistenceRecoverySettledEvent[] = [];
  readonly effectOrder: string[] = [];
  recoveryLifecycle: SemanticCanvasEditLifecycleController | null = null;
  ensureImpl: (
    targets: readonly ObjectLeaseAcquireTarget[],
  ) => Promise<{ room: RoomState; leases: readonly ObjectLease[] }>;
  commandImpl: (command: CanvasCommand) => Promise<{ room: RoomState; changedObjectIds: string[] }>;
  transactionImpl: (
    transaction: SemanticTransaction,
  ) => Promise<{ room: RoomState; changedObjectIds: string[] }>;
  refreshImpl: () => Promise<RoomState>;
  classifyImpl: SemanticEditPersistenceHost["classifyError"] = () => ({
    kind: "confirmed-failure",
  });
  private readonly cohortTargets = new Map<string, Set<string>>();
  private readonly cohortIdsByObject = new Map<string, Set<string>>();

  constructor(
    private readonly coordinator: CanvasObjectSyncCoordinator,
    room: RoomState,
  ) {
    this.room = room;
    this.ensureImpl = async (targets) => {
      const next = structuredClone(this.room);
      const leases = targets.map(leaseFor);
      for (const lease of leases) next.leases[lease.objectId] = lease;
      next.stateRevision = (next.stateRevision ?? next.roomRevision) + 1;
      return { room: next, leases };
    };
    this.commandImpl = async (command) => {
      const next = applyCommands(this.room, [command]);
      return { room: next, changedObjectIds: changedIds([command]) };
    };
    this.transactionImpl = async (transaction) => {
      const next = applyCommands(this.room, transaction.commands);
      return { room: next, changedObjectIds: changedIds(transaction.commands) };
    };
    this.refreshImpl = async () => this.room;
  }

  readonly host: SemanticEditPersistenceHost = {
    currentRoom: () => this.room,
    ensureLeaseCohort: async ({ cohortId, targets }) => {
      this.ensureCalls.push({
        cohortId,
        targets: targets.map((target) => ({ ...target })),
      });
      const cohort = this.cohortTargets.get(cohortId) ?? new Set<string>();
      for (const target of targets) {
        cohort.add(target.objectId);
        const references = this.cohortIdsByObject.get(target.objectId) ?? new Set<string>();
        references.add(cohortId);
        this.cohortIdsByObject.set(target.objectId, references);
      }
      this.cohortTargets.set(cohortId, cohort);
      const missing = targets.filter(
        (target) => !this.coordinator.get(target.objectId)?.lease,
      );
      if (missing.length) {
        const result = await this.ensureImpl(missing);
        this.room = result.room;
        for (const lease of result.leases) {
          this.coordinator.getOrCreate(
            lease.objectId,
            lease.objectRevision,
          ).lease = { lease, renewTimer: null };
        }
      }
      const leases = new Map<string, ObjectLease>();
      for (const objectId of cohort) {
        const lease = this.coordinator.get(objectId)?.lease?.lease;
        if (lease) leases.set(objectId, lease);
      }
      return { cohortId, objectIds: [...cohort], leases };
    },
    releaseLeaseCohort: async (cohortId) => {
      this.effectOrder.push(`release:${cohortId}`);
      this.releaseCalls.push(cohortId);
      for (const objectId of this.cohortTargets.get(cohortId) ?? []) {
        const references = this.cohortIdsByObject.get(objectId);
        references?.delete(cohortId);
        if (!references?.size) {
          this.cohortIdsByObject.delete(objectId);
          const entry = this.coordinator.get(objectId);
          if (entry) entry.lease = null;
          delete this.room.leases[objectId];
          this.coordinator.prune(objectId);
        }
      }
      this.cohortTargets.delete(cohortId);
    },
    command: async (command) => {
      this.commandCalls.push(structuredClone(command));
      return this.commandImpl(command);
    },
    semanticTransaction: async (transaction) => {
      this.transactionCalls.push(structuredClone(transaction));
      return this.transactionImpl(transaction);
    },
    refresh: () => this.refreshImpl(),
    acceptRoom: (room) => {
      this.acceptedRooms.push(room);
      const currentStateRevision = this.room.stateRevision ?? this.room.roomRevision;
      const incomingStateRevision = room.stateRevision ?? room.roomRevision;
      if (
        room.roomRevision > this.room.roomRevision ||
        (room.roomRevision === this.room.roomRevision &&
          incomingStateRevision >= currentStateRevision)
      ) {
        this.room = room;
      }
      return this.room;
    },
    classifyError: (error) => this.classifyImpl(error),
    onFailureConfirmed: (error) => {
      this.effectOrder.push("failure-confirmed");
      this.confirmedFailures.push(error);
    },
    onAcknowledged: (event) => {
      this.acknowledgements.push(event);
    },
    onRollback: (event) => {
      this.effectOrder.push(`rollback:${event.objectIds.join(",")}`);
      this.rollbacks.push(event);
    },
    onRecoverySettled: (event) => {
      this.effectOrder.push(`settled:${event.gestureId ?? "anonymous"}`);
      this.recoverySettlements.push(event);
      if (event.gestureId && this.recoveryLifecycle) {
        this.recoveryLifecycle.dispatch({
          type: "gesture.recovery-settled",
          gestureId: event.gestureId,
          authoritative: event.authoritative,
        });
      }
    },
  };
}

function changedIds(commands: readonly CanvasCommand[]): string[] {
  return commands.flatMap((command) => {
    if (command.type === "create") return [command.object.id];
    if (command.type === "update") return [command.objectId];
    return command.targets.map((target) => target.objectId);
  });
}

function consumeAll(
  driver: SemanticCanvasEditPersistenceDriver,
  intents: readonly SemanticCanvasEditIntent[],
): void {
  for (const intent of intents) driver.consume(intent);
}

async function microtasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("Condition did not settle within 50 microtasks.");
}

function startUpdate(
  lifecycle: SemanticCanvasEditLifecycleController,
  driver: SemanticCanvasEditPersistenceDriver,
  object: Shape,
  next: ShapeDraft,
  operation: "move" | "edit" = "move",
  gestureId: string | null = null,
  cohortId = "cohort",
): SemanticCanvasEditIntent[] {
  const intents = lifecycle.dispatch({
    type: "objects.changed",
    gestureId,
    cohortId,
    changes: [
      {
        kind: "update",
        draft: next,
        baseRevision: object.revision,
        baseCreatedAt: object.createdAt,
        operation,
      },
    ],
  });
  consumeAll(driver, intents);
  return [...intents];
}

describe("SemanticCanvasEditPersistenceDriver", () => {
  it("explicitly unregisters Diagram restorations when replay dispatch never reaches a batch", async () => {
    const object = shape("a", 1);
    const coordinator = new CanvasObjectSyncCoordinator();
    const lifecycle = new SemanticCanvasEditLifecycleController(coordinator);
    const harness = new PersistenceHarness(coordinator, roomWith([object]));
    const clock = new FakeClock();
    const driver = new SemanticCanvasEditPersistenceDriver(coordinator, harness.host, clock);
    const target: Diagram = {
      id: "diagram-1",
      title: "Architecture",
      description: "Restoration that must be discarded",
      diagramType: "architecture",
      category: "system",
      tags: [],
      memberObjectIds: ["a"],
      connectorIds: [],
      bounds: { x: 10, y: 20, width: 160, height: 90 },
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
      createdBy: actor,
      lastEditedBy: actor,
    };
    const gestureId = "history:failed-before-batch";
    driver.registerDiagramRestorations(gestureId, [{ diagramId: target.id, target }]);
    driver.unregisterDiagramRestorations(gestureId);

    consumeAll(driver, lifecycle.dispatch({
      type: "gesture.started",
      gestureId,
      source: "pointer",
      objects: [{ objectId: object.id, baseRevision: object.revision, baseCreatedAt: object.createdAt, operation: "move" }],
    }));
    startUpdate(lifecycle, driver, object, draft(object, { x: 50 }), "move", gestureId);
    clock.advance(SEMANTIC_EDIT_DEBOUNCE_MS);
    await driver.whenIdle();

    expect(harness.commandCalls).toHaveLength(1);
    expect(harness.transactionCalls).toHaveLength(0);
    expect(harness.room.diagrams).toEqual({});
    driver.dispose();
  });

  it("does not report idle while a local edit is still waiting in the debounce window", async () => {
    const object = shape("a", 4);
    const coordinator = new CanvasObjectSyncCoordinator();
    const lifecycle = new SemanticCanvasEditLifecycleController(coordinator);
    const harness = new PersistenceHarness(coordinator, roomWith([object]));
    const clock = new FakeClock();
    const driver = new SemanticCanvasEditPersistenceDriver(coordinator, harness.host, clock);

    startUpdate(lifecycle, driver, object, draft(object, { x: 90 }));
    let idleSettled = false;
    const idle = driver.whenIdle().then(() => {
      idleSettled = true;
    });
    await microtasks();

    expect(idleSettled).toBe(false);
    expect(harness.commandCalls).toHaveLength(0);

    clock.advance(SEMANTIC_EDIT_DEBOUNCE_MS);
    await idle;

    expect(idleSettled).toBe(true);
    expect(harness.commandCalls).toHaveLength(1);
    expect(harness.room.objects.a).toMatchObject({ x: 90, revision: 5 });
  });

  it("waits for delayed atomic lease acquisition before writing", async () => {
    const object = shape("a", 4);
    const coordinator = new CanvasObjectSyncCoordinator();
    const lifecycle = new SemanticCanvasEditLifecycleController(coordinator);
    const harness = new PersistenceHarness(coordinator, roomWith([object]));
    const leases = deferred<{ room: RoomState; leases: readonly ObjectLease[] }>();
    harness.ensureImpl = () => leases.promise;
    const clock = new FakeClock();
    const driver = new SemanticCanvasEditPersistenceDriver(
      coordinator,
      harness.host,
      clock,
    );

    startUpdate(lifecycle, driver, object, draft(object, { x: 90 }));
    clock.advance(SEMANTIC_EDIT_DEBOUNCE_MS);
    await microtasks();
    expect(harness.commandCalls).toHaveLength(0);
    expect(coordinator.protectedObjectIds()).toEqual(new Set(["a"]));

    const leasedRoom = structuredClone(harness.room);
    const lease = leaseFor({ objectId: "a", expectedRevision: 4, operation: "move" });
    leasedRoom.leases.a = lease;
    leases.resolve({ room: leasedRoom, leases: [lease] });
    await driver.whenIdle();

    expect(harness.commandCalls).toEqual([
      {
        type: "move",
        targets: [
          {
            objectId: "a",
            expectedRevision: 4,
            x: 90,
            y: 20,
            leaseId: lease.leaseId,
          },
        ],
      },
    ]);
    expect(harness.acceptedRooms.at(-1)?.objects.a.revision).toBe(5);
  });

  it("serializes two same-object generations and builds the second at revision N+1", async () => {
    const object = shape("a", 7);
    const coordinator = new CanvasObjectSyncCoordinator();
    const lifecycle = new SemanticCanvasEditLifecycleController(coordinator);
    const harness = new PersistenceHarness(coordinator, roomWith([object]));
    const firstSave = deferred<{ room: RoomState; changedObjectIds: string[] }>();
    harness.commandImpl = async (command) => {
      if (harness.commandCalls.length === 1) return firstSave.promise;
      const next = applyCommands(harness.room, [command]);
      return { room: next, changedObjectIds: ["a"] };
    };
    const clock = new FakeClock();
    const driver = new SemanticCanvasEditPersistenceDriver(coordinator, harness.host, clock);

    startUpdate(lifecycle, driver, object, draft(object, { x: 100 }), "move", null, "move-a");
    clock.advance(SEMANTIC_EDIT_DEBOUNCE_MS);
    await microtasks();
    expect(harness.commandCalls[0]).toMatchObject({
      type: "move",
      targets: [{ expectedRevision: 7, x: 100 }],
    });

    startUpdate(lifecycle, driver, object, draft(object, { x: 180 }), "move", null, "move-a");
    clock.advance(SEMANTIC_EDIT_DEBOUNCE_MS);
    await microtasks();
    expect(harness.commandCalls).toHaveLength(1);

    const firstAuthoritative = applyCommands(harness.room, [harness.commandCalls[0]]);
    firstSave.resolve({ room: firstAuthoritative, changedObjectIds: ["a"] });
    await waitUntil(() => harness.commandCalls.length === 2);
    expect(harness.commandCalls).toHaveLength(2);
    expect(harness.commandCalls[1]).toMatchObject({
      type: "move",
      targets: [{ expectedRevision: 8, x: 180 }],
    });
    await driver.whenIdle();

    expect(harness.acknowledgements.flatMap((event) => event.acknowledgements))
      .toMatchObject([
        { generation: 1, revision: 8, latestGenerationSettled: false },
        { generation: 2, revision: 9, latestGenerationSettled: true },
      ]);
    expect(harness.acknowledgements.at(-1)?.acknowledgements[0]).toMatchObject({
      generation: 2,
      revision: 9,
      latestGenerationSettled: true,
    });
    expect(coordinator.get("a") ?? null).toBeNull();
  });

  it("deduplicates a fired debounce and identical final flush while releasing after settle", async () => {
    const object = shape("a", 2);
    const coordinator = new CanvasObjectSyncCoordinator();
    const lifecycle = new SemanticCanvasEditLifecycleController(coordinator);
    const harness = new PersistenceHarness(coordinator, roomWith([object]));
    const clock = new FakeClock();
    const driver = new SemanticCanvasEditPersistenceDriver(coordinator, harness.host, clock);

    consumeAll(driver, lifecycle.dispatch({
      type: "gesture.started",
      gestureId: "pointer-1",
      source: "pointer",
      objects: [
        {
          objectId: "a",
          baseRevision: object.revision,
          baseCreatedAt: object.createdAt,
          operation: "move",
        },
      ],
    }));
    startUpdate(
      lifecycle,
      driver,
      object,
      draft(object, { x: 60 }),
      "move",
      "pointer-1",
    );
    clock.advance(SEMANTIC_EDIT_DEBOUNCE_MS);
    await driver.whenIdle();
    expect(harness.commandCalls).toHaveLength(1);
    expect(harness.releaseCalls).toHaveLength(0);

    const settle = lifecycle.dispatch({
      type: "gesture.finish-requested",
      gestureId: "pointer-1",
      reason: "pointer-up",
    }).find((intent) => intent.type === "gesture.settle");
    if (!settle || settle.type !== "gesture.settle") throw new Error("missing settle");
    const flush = lifecycle.dispatch({ type: "gesture.settled", token: settle.token });
    consumeAll(driver, flush);
    await driver.whenIdle();

    expect(harness.commandCalls).toHaveLength(1);
    expect(harness.releaseCalls).toHaveLength(1);
    expect(coordinator.protectedObjectIds()).toEqual(new Set());
  });

  it("retires a move-away-and-return gesture without a command or revision bump", async () => {
    const object = shape("a", 2, 10);
    const coordinator = new CanvasObjectSyncCoordinator();
    const lifecycle = new SemanticCanvasEditLifecycleController(coordinator);
    const harness = new PersistenceHarness(coordinator, roomWith([object]));
    const clock = new FakeClock();
    const driver = new SemanticCanvasEditPersistenceDriver(coordinator, harness.host, clock);

    consumeAll(driver, lifecycle.dispatch({
      type: "gesture.started",
      gestureId: "pointer-noop",
      source: "pointer",
      objects: [{
        objectId: object.id,
        baseRevision: object.revision,
        baseCreatedAt: object.createdAt,
        operation: "move",
      }],
    }));
    startUpdate(lifecycle, driver, object, draft(object, { x: 80 }), "move", "pointer-noop");
    startUpdate(lifecycle, driver, object, draft(object), "move", "pointer-noop");

    const settle = lifecycle.dispatch({
      type: "gesture.finish-requested",
      gestureId: "pointer-noop",
      reason: "pointer-up",
    }).find((intent) => intent.type === "gesture.settle");
    if (!settle || settle.type !== "gesture.settle") throw new Error("missing settle");
    consumeAll(driver, lifecycle.dispatch({ type: "gesture.settled", token: settle.token }));
    await driver.whenIdle();

    expect(harness.commandCalls).toEqual([]);
    expect(harness.transactionCalls).toEqual([]);
    expect(harness.room.objects.a).toMatchObject({ x: 10, revision: 2 });
    expect(harness.releaseCalls).toEqual(["pointer-noop"]);
    expect(coordinator.protectedObjectIds()).toEqual(new Set());
  });

  it("retires a grouped no-op move with its connector dependency atomically", async () => {
    const left = { ...shape("left", 3, 10), groupId: "group-a" };
    const right = { ...shape("right", 5, 310), groupId: "group-a" };
    const edge = connector("edge", left.id, right.id);
    const coordinator = new CanvasObjectSyncCoordinator();
    const lifecycle = new SemanticCanvasEditLifecycleController(coordinator);
    const harness = new PersistenceHarness(coordinator, roomWith([left, right, edge]));
    const driver = new SemanticCanvasEditPersistenceDriver(
      coordinator,
      harness.host,
      new FakeClock(),
    );
    const gestureId = "group-noop";

    consumeAll(driver, lifecycle.dispatch({
      type: "gesture.started",
      gestureId,
      source: "pointer",
      objects: [
        { objectId: left.id, baseRevision: left.revision, baseCreatedAt: left.createdAt, operation: "move" },
        { objectId: right.id, baseRevision: right.revision, baseCreatedAt: right.createdAt, operation: "move" },
        { objectId: edge.id, baseRevision: edge.revision, baseCreatedAt: edge.createdAt, operation: "connect" },
      ],
    }));
    for (const next of [
      [draft(left, { x: 90 }), draft(right, { x: 390 })],
      [draft(left), draft(right)],
    ]) {
      consumeAll(driver, lifecycle.dispatch({
        type: "objects.changed",
        gestureId,
        changes: next.map((item) => ({
          kind: "update" as const,
          draft: item,
          baseRevision: item.id === left.id ? left.revision : right.revision,
          baseCreatedAt: item.id === left.id ? left.createdAt : right.createdAt,
          operation: "move" as const,
        })),
      }));
    }
    const settle = lifecycle.dispatch({
      type: "gesture.finish-requested",
      gestureId,
      reason: "pointer-up",
    }).find((intent) => intent.type === "gesture.settle");
    if (!settle || settle.type !== "gesture.settle") throw new Error("missing settle");
    consumeAll(driver, lifecycle.dispatch({ type: "gesture.settled", token: settle.token }));
    await driver.whenIdle();

    expect(harness.commandCalls).toEqual([]);
    expect(harness.transactionCalls).toEqual([]);
    expect(harness.room.objects).toMatchObject({
      left: { x: 10, revision: 3 },
      right: { x: 310, revision: 5 },
      edge: { revision: 1 },
    });
    expect(harness.releaseCalls).toEqual([gestureId]);
  });

  it("absorbs only overlapping keyboard work while disjoint work remains independent", async () => {
    const a = shape("a", 2, 10);
    const b = shape("b", 4, 300);
    const coordinator = new CanvasObjectSyncCoordinator();
    const lifecycle = new SemanticCanvasEditLifecycleController(coordinator);
    const harness = new PersistenceHarness(coordinator, roomWith([a, b]));
    const driver = new SemanticCanvasEditPersistenceDriver(
      coordinator,
      harness.host,
      new FakeClock(),
    );
    const keyboardId = "semantic-keyboard:nudge:1";
    const pointerId = "semantic-move:1";

    consumeAll(driver, lifecycle.dispatch({
      type: "gesture.started",
      gestureId: keyboardId,
      source: "keyboard",
      objects: [a, b].map((object) => ({
        objectId: object.id,
        baseRevision: object.revision,
        baseCreatedAt: object.createdAt,
        operation: "move" as const,
      })),
    }));
    consumeAll(driver, lifecycle.dispatch({
      type: "objects.changed",
      gestureId: keyboardId,
      changes: [
        { kind: "update", draft: draft(a, { x: 11 }), baseRevision: a.revision, baseCreatedAt: a.createdAt, operation: "move" },
        { kind: "update", draft: draft(b, { x: 301 }), baseRevision: b.revision, baseCreatedAt: b.createdAt, operation: "move" },
      ],
    }));
    expect(driver.absorbPendingGestureObjects({
      fromGestureIds: new Set([keyboardId]),
      objectIds: [a.id],
    })).toEqual([a.id]);
    consumeAll(driver, lifecycle.dispatch({
      type: "gesture.started",
      gestureId: pointerId,
      source: "pointer",
      objects: [{ objectId: a.id, baseRevision: a.revision, baseCreatedAt: a.createdAt, operation: "move" }],
    }));

    const keyboardSettle = lifecycle.dispatch({
      type: "gesture.finish-requested",
      gestureId: keyboardId,
      reason: "keyboard-idle",
    }).find((intent) => intent.type === "gesture.settle");
    if (!keyboardSettle || keyboardSettle.type !== "gesture.settle") throw new Error("missing keyboard settle");
    consumeAll(driver, lifecycle.dispatch({ type: "gesture.settled", token: keyboardSettle.token }));
    await driver.whenIdle();
    expect(harness.commandCalls).toEqual([
      expect.objectContaining({ type: "move", targets: [expect.objectContaining({ objectId: b.id, x: 301 })] }),
    ]);

    consumeAll(driver, lifecycle.dispatch({
      type: "objects.changed",
      gestureId: pointerId,
      changes: [{
        kind: "update",
        draft: draft(a, { x: 91 }),
        baseRevision: a.revision,
        baseCreatedAt: a.createdAt,
        operation: "move",
      }],
    }));
    const pointerSettle = lifecycle.dispatch({
      type: "gesture.finish-requested",
      gestureId: pointerId,
      reason: "pointer-up",
    }).find((intent) => intent.type === "gesture.settle");
    if (!pointerSettle || pointerSettle.type !== "gesture.settle") throw new Error("missing pointer settle");
    consumeAll(driver, lifecycle.dispatch({ type: "gesture.settled", token: pointerSettle.token }));
    await driver.whenIdle();

    expect(harness.commandCalls).toHaveLength(2);
    expect(harness.commandCalls[1]).toMatchObject({
      type: "move",
      targets: [expect.objectContaining({ objectId: a.id, x: 91 })],
    });
    expect(harness.room.objects).toMatchObject({
      a: { x: 91, revision: 3 },
      b: { x: 301, revision: 5 },
    });
  });

  it("treats server-managed resolvedAt as equal when a decision returns to its origin", async () => {
    const object: Shape = {
      ...shape("decision", 6, 40),
      nodeType: "decision",
      nodeMetadata: {
        kind: "decision",
        status: "accepted",
        owner: "Ada",
        resolution: "Ship it",
        resolvedAt: 9_000,
      },
    };
    const coordinator = new CanvasObjectSyncCoordinator();
    const lifecycle = new SemanticCanvasEditLifecycleController(coordinator);
    const harness = new PersistenceHarness(coordinator, roomWith([object]));
    const clock = new FakeClock();
    const driver = new SemanticCanvasEditPersistenceDriver(coordinator, harness.host, clock);
    const gestureId = "decision-noop";

    consumeAll(driver, lifecycle.dispatch({
      type: "gesture.started",
      gestureId,
      source: "pointer",
      objects: [{
        objectId: object.id,
        baseRevision: object.revision,
        baseCreatedAt: object.createdAt,
        operation: "move",
      }],
    }));
    startUpdate(lifecycle, driver, object, {
      ...draft(object),
      nodeMetadata: {
        kind: "decision",
        status: "accepted",
        owner: "Ada",
        resolution: "Ship it",
      },
    }, "move", gestureId);
    const settle = lifecycle.dispatch({
      type: "gesture.finish-requested",
      gestureId,
      reason: "pointer-up",
    }).find((intent) => intent.type === "gesture.settle");
    if (!settle || settle.type !== "gesture.settle") throw new Error("missing settle");
    consumeAll(driver, lifecycle.dispatch({ type: "gesture.settled", token: settle.token }));
    await driver.whenIdle();

    expect(harness.commandCalls).toEqual([]);
    expect(harness.room.objects.decision).toMatchObject({ revision: 6, x: 40 });
    expect(harness.releaseCalls).toEqual([gestureId]);
  });

  it("combines a multi-object all-move cohort into one atomic command", async () => {
    const a = shape("a", 2, 10, 1_000);
    const b = shape("b", 5, 300, 2_000);
    const coordinator = new CanvasObjectSyncCoordinator();
    const lifecycle = new SemanticCanvasEditLifecycleController(coordinator);
    const harness = new PersistenceHarness(coordinator, roomWith([a, b]));
    const clock = new FakeClock();
    const driver = new SemanticCanvasEditPersistenceDriver(coordinator, harness.host, clock);

    consumeAll(driver, lifecycle.dispatch({
      type: "objects.changed",
      gestureId: null,
      cohortId: "multi-move",
      changes: [
        {
          kind: "update",
          draft: draft(a, { x: 50, y: 80 }),
          baseRevision: a.revision,
          baseCreatedAt: a.createdAt,
          operation: "move",
        },
        {
          kind: "update",
          draft: draft(b, { x: 340, y: 90 }),
          baseRevision: b.revision,
          baseCreatedAt: b.createdAt,
          operation: "move",
        },
      ],
    }));
    clock.advance(SEMANTIC_EDIT_DEBOUNCE_MS);
    await driver.whenIdle();

    expect(harness.transactionCalls).toHaveLength(0);
    expect(harness.commandCalls).toHaveLength(1);
    expect(harness.commandCalls[0]).toEqual({
      type: "move",
      targets: [
        expect.objectContaining({ objectId: "a", expectedRevision: 2, x: 50, y: 80 }),
        expect.objectContaining({ objectId: "b", expectedRevision: 5, x: 340, y: 90 }),
      ],
    });
  });

  it("releases only the acknowledged gesture ref when a newer gesture overlaps", async () => {
    const object = shape("a", 4);
    const coordinator = new CanvasObjectSyncCoordinator();
    const lifecycle = new SemanticCanvasEditLifecycleController(coordinator);
    const harness = new PersistenceHarness(coordinator, roomWith([object]));
    const firstSave = deferred<{ room: RoomState; changedObjectIds: string[] }>();
    const secondSave = deferred<{ room: RoomState; changedObjectIds: string[] }>();
    harness.commandImpl = async () =>
      harness.commandCalls.length === 1 ? firstSave.promise : secondSave.promise;
    const clock = new FakeClock();
    const driver = new SemanticCanvasEditPersistenceDriver(coordinator, harness.host, clock);

    const beginGesture = (gestureId: string, x: number) => {
      consumeAll(driver, lifecycle.dispatch({
        type: "gesture.started",
        gestureId,
        source: "pointer",
        objects: [
          {
            objectId: "a",
            baseRevision: object.revision,
            baseCreatedAt: object.createdAt,
            operation: "move",
          },
        ],
      }));
      startUpdate(
        lifecycle,
        driver,
        object,
        draft(object, { x }),
        "move",
        gestureId,
      );
      const settle = lifecycle.dispatch({
        type: "gesture.finish-requested",
        gestureId,
        reason: "pointer-up",
      }).find((intent) => intent.type === "gesture.settle");
      if (!settle || settle.type !== "gesture.settle") throw new Error("missing settle");
      consumeAll(driver, lifecycle.dispatch({ type: "gesture.settled", token: settle.token }));
    };

    beginGesture("gesture-a", 100);
    await microtasks();
    expect(harness.commandCalls).toHaveLength(1);
    beginGesture("gesture-b", 180);
    await microtasks();
    expect(harness.commandCalls).toHaveLength(1);

    firstSave.resolve({
      room: applyCommands(harness.room, [harness.commandCalls[0]]),
      changedObjectIds: ["a"],
    });
    await waitUntil(() => harness.commandCalls.length === 2);

    expect(harness.releaseCalls).toEqual(["gesture-a"]);
    expect(coordinator.get("a")?.lease).not.toBeNull();
    expect(harness.commandCalls).toHaveLength(2);
    expect(harness.commandCalls[1]).toMatchObject({
      type: "move",
      targets: [{ expectedRevision: 5, x: 180 }],
    });

    secondSave.resolve({
      room: applyCommands(harness.room, [harness.commandCalls[1]]),
      changedObjectIds: ["a"],
    });
    await driver.whenIdle();
    expect(harness.releaseCalls).toEqual(["gesture-a", "gesture-b"]);
    expect(coordinator.get("a")?.lease ?? null).toBeNull();
  });

  it("leases, protects, acknowledges, and releases dependency-only object IDs", async () => {
    const a = shape("a", 2, 10, 1_000);
    const connector = shape("connector-dependency", 9, 200, 9_000);
    const coordinator = new CanvasObjectSyncCoordinator();
    const lifecycle = new SemanticCanvasEditLifecycleController(coordinator);
    const harness = new PersistenceHarness(coordinator, roomWith([a, connector]));
    const save = deferred<{ room: RoomState; changedObjectIds: string[] }>();
    harness.commandImpl = () => save.promise;
    const clock = new FakeClock();
    const driver = new SemanticCanvasEditPersistenceDriver(coordinator, harness.host, clock);

    consumeAll(driver, lifecycle.dispatch({
      type: "gesture.started",
      gestureId: "group-move",
      source: "pointer",
      objects: [
        { objectId: "a", baseRevision: 2, baseCreatedAt: 1_000, operation: "move" },
      ],
    }));
    const dependencyEvent = {
      type: "gesture.dependencies-added" as const,
      gestureId: "group-move",
      objects: [
        {
          objectId: "connector-dependency",
          baseRevision: 9,
          baseCreatedAt: 9_000,
          operation: "connect" as const,
        },
      ],
    };
    consumeAll(driver, lifecycle.dispatch(dependencyEvent));
    expect(lifecycle.dispatch(dependencyEvent)).toEqual([]);
    startUpdate(
      lifecycle,
      driver,
      a,
      draft(a, { x: 90 }),
      "move",
      "group-move",
    );
    const settle = lifecycle.dispatch({
      type: "gesture.finish-requested",
      gestureId: "group-move",
      reason: "pointer-up",
    }).find((intent) => intent.type === "gesture.settle");
    if (!settle || settle.type !== "gesture.settle") throw new Error("missing settle");
    consumeAll(driver, lifecycle.dispatch({ type: "gesture.settled", token: settle.token }));
    await microtasks();

    expect(harness.ensureCalls).toEqual([
      {
        cohortId: "group-move",
        targets: [{ objectId: "a", expectedRevision: 2, operation: "move" }],
      },
      {
        cohortId: "group-move",
        targets: [
          {
            objectId: "connector-dependency",
            expectedRevision: 9,
            operation: "connect",
          },
        ],
      },
    ]);
    expect(coordinator.protectedObjectIds()).toEqual(
      new Set(["a", "connector-dependency"]),
    );
    expect(harness.commandCalls[0]).toMatchObject({
      type: "move",
      targets: [{ objectId: "a" }],
    });

    const result = applyCommands(harness.room, [harness.commandCalls[0]]);
    result.objects["connector-dependency"].revision += 1;
    save.resolve({ room: result, changedObjectIds: ["a", "connector-dependency"] });
    await driver.whenIdle();

    expect(harness.acknowledgements[0].objectIds).toEqual([
      "a",
      "connector-dependency",
    ]);
    expect(harness.acknowledgements[0].acknowledgements).toContainEqual(
      expect.objectContaining({
        objectId: "connector-dependency",
        revision: 10,
        latestGenerationSettled: true,
      }),
    );
    expect(harness.releaseCalls).toEqual(["group-move"]);
  });

  it("uses one semantic transaction for mixed create, update, and delete work", async () => {
    const update = shape("update", 3, 10, 1_000);
    const remove = shape("remove", 6, 300, 2_000);
    const coordinator = new CanvasObjectSyncCoordinator();
    const lifecycle = new SemanticCanvasEditLifecycleController(coordinator);
    const harness = new PersistenceHarness(coordinator, roomWith([update, remove]));
    const clock = new FakeClock();
    const driver = new SemanticCanvasEditPersistenceDriver(coordinator, harness.host, clock);
    const created = draft(shape("new", 0, 500, 3_000), { label: "created" });

    consumeAll(driver, lifecycle.dispatch({
      type: "objects.changed",
      gestureId: null,
      cohortId: "mixed",
      changes: [
        { kind: "create", draft: created, baseRevision: null, baseCreatedAt: null },
        {
          kind: "update",
          draft: draft(update, { label: "updated" }),
          baseRevision: update.revision,
          baseCreatedAt: update.createdAt,
          operation: "edit",
        },
        {
          kind: "delete",
          objectId: remove.id,
          baseRevision: remove.revision,
          baseCreatedAt: remove.createdAt,
          operation: "delete",
        },
      ],
    }));
    clock.advance(SEMANTIC_EDIT_DEBOUNCE_MS);
    await driver.whenIdle();

    expect(harness.commandCalls).toHaveLength(0);
    expect(harness.transactionCalls).toHaveLength(1);
    expect(harness.transactionCalls[0].commands.map((command) => command.type)).toEqual([
      "create",
      "update",
      "delete",
    ]);
    expect(harness.room.objects.new).toMatchObject({ label: "created", revision: 1 });
    expect(harness.room.objects.update).toMatchObject({ label: "updated", revision: 4 });
    expect(harness.room.objects.remove).toBeUndefined();
  });

  it("fences a failed cohort, retries only refresh, then rolls back once", async () => {
    const object = shape("a", 4);
    const coordinator = new CanvasObjectSyncCoordinator();
    const lifecycle = new SemanticCanvasEditLifecycleController(coordinator);
    const harness = new PersistenceHarness(coordinator, roomWith([object]));
    const conflict = new Error("revision conflict");
    harness.commandImpl = async () => Promise.reject(conflict);
    let refreshCount = 0;
    harness.refreshImpl = async () => {
      refreshCount += 1;
      if (refreshCount === 1) throw new Error("network unavailable");
      return roomWith([shape("a", 5)], 11);
    };
    const clock = new FakeClock();
    const driver = new SemanticCanvasEditPersistenceDriver(coordinator, harness.host, clock);

    harness.recoveryLifecycle = lifecycle;
    consumeAll(driver, lifecycle.dispatch({
      type: "gesture.started",
      gestureId: "pointer-failure",
      source: "pointer",
      objects: [
        {
          objectId: "a",
          baseRevision: object.revision,
          baseCreatedAt: object.createdAt,
          operation: "move",
        },
      ],
    }));
    startUpdate(
      lifecycle,
      driver,
      object,
      draft(object, { x: 120 }),
      "move",
      "pointer-failure",
    );
    clock.advance(SEMANTIC_EDIT_DEBOUNCE_MS);
    await microtasks();

    expect(harness.commandCalls).toHaveLength(1);
    expect(harness.confirmedFailures).toEqual([conflict]);
    expect(harness.rollbacks).toHaveLength(0);
    expect(coordinator.get("a")).toMatchObject({ awaitingRecovery: true, dirty: true });
    expect(coordinator.protectedObjectIds()).toEqual(new Set(["a"]));

    clock.advance(SEMANTIC_EDIT_RECOVERY_RETRY_MS);
    await driver.whenIdle();

    expect(refreshCount).toBe(2);
    expect(harness.commandCalls).toHaveLength(1);
    expect(harness.rollbacks).toHaveLength(1);
    expect(harness.rollbacks[0]).toMatchObject({
      objectIds: ["a"],
      gestureId: "pointer-failure",
      error: conflict,
      reason: "confirmed-failure",
    });
    expect(coordinator.get("a") ?? null).toBeNull();
    expect(coordinator.protectedObjectIds()).toEqual(new Set());
    expect(harness.effectOrder).toEqual([
      "failure-confirmed",
      "rollback:a",
      "release:pointer-failure",
      "settled:pointer-failure",
    ]);
    expect(lifecycle.dispatch({
      type: "gesture.finish-requested",
      gestureId: "pointer-failure",
      reason: "pointer-up",
    })).toEqual([]);
  });

  it("refreshes a committed replay until visible and acknowledges instead of rolling back", async () => {
    const object = shape("a", 12);
    const coordinator = new CanvasObjectSyncCoordinator();
    const lifecycle = new SemanticCanvasEditLifecycleController(coordinator);
    const harness = new PersistenceHarness(coordinator, roomWith([object], 20));
    const replay = new Error("outcome unknown");
    harness.classifyImpl = (error) =>
      error === replay
        ? { kind: "committed-replay", committedRoomRevision: 21 }
        : { kind: "confirmed-failure" };
    harness.commandImpl = async () => Promise.reject(replay);
    let refreshCount = 0;
    harness.refreshImpl = async () => {
      refreshCount += 1;
      return refreshCount === 1
        ? roomWith([object], 20)
        : roomWith([shape("a", 13, 140)], 21);
    };
    const clock = new FakeClock();
    const driver = new SemanticCanvasEditPersistenceDriver(coordinator, harness.host, clock);

    startUpdate(lifecycle, driver, object, draft(object, { x: 140 }));
    clock.advance(SEMANTIC_EDIT_DEBOUNCE_MS);
    await microtasks();
    expect(refreshCount).toBe(1);
    expect(harness.rollbacks).toHaveLength(0);

    clock.advance(SEMANTIC_EDIT_RECOVERY_RETRY_MS);
    await driver.whenIdle();

    expect(refreshCount).toBe(2);
    expect(harness.commandCalls).toHaveLength(1);
    expect(harness.rollbacks).toHaveLength(0);
    expect(harness.acknowledgements).toHaveLength(1);
    expect(harness.acknowledgements[0]).toMatchObject({ committedReplay: true });
    expect(harness.acknowledgements[0].acknowledgements[0]).toMatchObject({
      revision: 13,
      latestGenerationSettled: true,
    });
    expect(coordinator.get("a") ?? null).toBeNull();
  });

  it("handles text cancellation through authoritative recovery without flushing", async () => {
    const object = shape("label", 3);
    const coordinator = new CanvasObjectSyncCoordinator();
    const lifecycle = new SemanticCanvasEditLifecycleController(coordinator);
    const harness = new PersistenceHarness(coordinator, roomWith([object]));
    harness.refreshImpl = async () => roomWith([shape("label", 3)], 11);
    const clock = new FakeClock();
    const driver = new SemanticCanvasEditPersistenceDriver(coordinator, harness.host, clock);
    harness.recoveryLifecycle = lifecycle;

    consumeAll(driver, lifecycle.dispatch({
      type: "gesture.started",
      gestureId: "text-1",
      source: "text",
      objects: [
        {
          objectId: "label",
          baseRevision: object.revision,
          baseCreatedAt: object.createdAt,
          operation: "edit",
        },
      ],
    }));
    startUpdate(
      lifecycle,
      driver,
      object,
      draft(object, { label: "temporary" }),
      "edit",
      "text-1",
    );
    const cancel = lifecycle.dispatch({
      type: "gesture.cancel-requested",
      gestureId: "text-1",
      reason: "text-cancel",
    });
    consumeAll(driver, cancel);
    await driver.whenIdle();
    clock.advance(SEMANTIC_EDIT_DEBOUNCE_MS * 2);
    await microtasks();

    expect(harness.commandCalls).toHaveLength(0);
    expect(harness.transactionCalls).toHaveLength(0);
    expect(harness.rollbacks).toHaveLength(1);
    expect(harness.rollbacks[0]).toMatchObject({
      reason: "cancelled",
      cancellationToken: expect.objectContaining({ gestureId: "text-1" }),
    });
    expect(clock.pending).toBe(0);
    expect(coordinator.protectedObjectIds()).toEqual(new Set());
    expect(lifecycle.dispatch({
      type: "gesture.finish-requested",
      gestureId: "text-1",
      reason: "text-blur",
    })).toEqual([]);
  });

  it("fences a newer overlapping gesture when an older save fails", async () => {
    const a = shape("a", 2, 10, 1_000);
    const b = shape("b", 3, 300, 2_000);
    const coordinator = new CanvasObjectSyncCoordinator();
    const lifecycle = new SemanticCanvasEditLifecycleController(coordinator);
    const harness = new PersistenceHarness(coordinator, roomWith([a, b]));
    const olderSave = deferred<{ room: RoomState; changedObjectIds: string[] }>();
    const refresh = deferred<RoomState>();
    harness.commandImpl = () => olderSave.promise;
    harness.refreshImpl = () => refresh.promise;
    const clock = new FakeClock();
    const driver = new SemanticCanvasEditPersistenceDriver(coordinator, harness.host, clock);
    harness.recoveryLifecycle = lifecycle;

    consumeAll(driver, lifecycle.dispatch({
      type: "gesture.started",
      gestureId: "older-a",
      source: "pointer",
      objects: [{
        objectId: a.id,
        baseRevision: a.revision,
        baseCreatedAt: a.createdAt,
        operation: "move",
      }],
    }));
    startUpdate(lifecycle, driver, a, draft(a, { x: 100 }), "move", "older-a");
    clock.advance(SEMANTIC_EDIT_DEBOUNCE_MS);
    await waitUntil(() => harness.commandCalls.length === 1);

    consumeAll(driver, lifecycle.dispatch({
      type: "gesture.started",
      gestureId: "newer-a-b",
      source: "pointer",
      objects: [a, b].map((object) => ({
        objectId: object.id,
        baseRevision: object.revision,
        baseCreatedAt: object.createdAt,
        operation: "move" as const,
      })),
    }));
    consumeAll(driver, lifecycle.dispatch({
      type: "objects.changed",
      gestureId: "newer-a-b",
      changes: [
        {
          kind: "update",
          draft: draft(a, { x: 190 }),
          baseRevision: a.revision,
          baseCreatedAt: a.createdAt,
          operation: "move",
        },
        {
          kind: "update",
          draft: draft(b, { x: 390 }),
          baseRevision: b.revision,
          baseCreatedAt: b.createdAt,
          operation: "move",
        },
      ],
    }));
    await microtasks();

    const failure = new Error("older A save failed");
    olderSave.reject(failure);
    await waitUntil(() => harness.confirmedFailures.length === 1);

    expect(harness.rollbacks).toHaveLength(0);
    expect(coordinator.get("a")).toMatchObject({ awaitingRecovery: true });
    expect(coordinator.get("b")).toMatchObject({ awaitingRecovery: true });
    expect(coordinator.protectedObjectIds()).toEqual(new Set(["a", "b"]));

    refresh.resolve(roomWith([a, b], 11));
    await driver.whenIdle();

    expect(harness.commandCalls).toHaveLength(1);
    expect(harness.confirmedFailures).toEqual([failure]);
    expect(harness.rollbacks).toHaveLength(1);
    expect(harness.rollbacks[0]).toMatchObject({
      objectIds: ["a", "b"],
      gestureId: "older-a",
      reason: "confirmed-failure",
    });
    expect(new Set(harness.releaseCalls)).toEqual(new Set(["older-a", "newer-a-b"]));
    expect(coordinator.protectedObjectIds()).toEqual(new Set());
    expect(driver.debugStateForTests()).toMatchObject({
      batches: 0,
      activeCohorts: 0,
      recoveries: 0,
    });
  });

  it("projects overlapping lease-cohort recovery as one atomic union", async () => {
    const x = shape("x", 2, 10, 1_000);
    const y = shape("y", 5, 300, 2_000);
    const coordinator = new CanvasObjectSyncCoordinator();
    coordinator.getOrCreate(x.id, x.revision, x.createdAt);
    coordinator.getOrCreate(y.id, y.revision, y.createdAt);
    const harness = new PersistenceHarness(coordinator, roomWith([x, y]));
    const firstRefresh = deferred<RoomState>();
    let refreshCount = 0;
    harness.refreshImpl = async () => {
      refreshCount += 1;
      return refreshCount === 1 ? firstRefresh.promise : harness.room;
    };
    const clock = new FakeClock();
    const driver = new SemanticCanvasEditPersistenceDriver(coordinator, harness.host, clock);

    await harness.host.ensureLeaseCohort({
      cohortId: "cohort-a",
      targets: [{ objectId: "x", expectedRevision: 2, operation: "move" }],
    });
    await harness.host.ensureLeaseCohort({
      cohortId: "cohort-b",
      targets: [
        { objectId: "x", expectedRevision: 2, operation: "move" },
        { objectId: "y", expectedRevision: 5, operation: "move" },
      ],
    });

    const recoveryA = driver.recoverLeaseCohort({
      cohortId: "cohort-a",
      objectIds: ["x"],
      cause: new Error("lost x in A"),
    });
    const recoveryB = driver.recoverLeaseCohort({
      cohortId: "cohort-b",
      objectIds: ["x", "y"],
      cause: new Error("lost x in B"),
    });
    expect(coordinator.protectedObjectIds()).toEqual(new Set(["x", "y"]));

    firstRefresh.resolve(roomWith([x, y], 11));
    await Promise.all([recoveryA, recoveryB]);
    await driver.whenIdle();

    expect(harness.rollbacks.map((rollback) => rollback.objectIds)).toEqual([
      ["x", "y"],
    ]);
    expect(harness.releaseCalls).toEqual(["cohort-a", "cohort-b"]);
    expect(coordinator.protectedObjectIds()).toEqual(new Set());
    expect(driver.debugStateForTests().recoveries).toBe(0);
  });

  it("drops completed batch and cohort metadata across many gestures", async () => {
    const coordinator = new CanvasObjectSyncCoordinator();
    const lifecycle = new SemanticCanvasEditLifecycleController(coordinator);
    const harness = new PersistenceHarness(
      coordinator,
      roomWith([shape("a", 1)]),
    );
    const clock = new FakeClock();
    const driver = new SemanticCanvasEditPersistenceDriver(coordinator, harness.host, clock);

    for (let index = 0; index < 20; index += 1) {
      const current = harness.room.objects.a as Shape;
      const gestureId = `gesture-${index}`;
      consumeAll(driver, lifecycle.dispatch({
        type: "gesture.started",
        gestureId,
        source: "pointer",
        objects: [
          {
            objectId: "a",
            baseRevision: current.revision,
            baseCreatedAt: current.createdAt,
            operation: "move",
          },
        ],
      }));
      startUpdate(
        lifecycle,
        driver,
        current,
        draft(current, { x: current.x + 10 }),
        "move",
        gestureId,
      );
      const settle = lifecycle.dispatch({
        type: "gesture.finish-requested",
        gestureId,
        reason: "pointer-up",
      }).find((intent) => intent.type === "gesture.settle");
      if (!settle || settle.type !== "gesture.settle") throw new Error("missing settle");
      consumeAll(driver, lifecycle.dispatch({ type: "gesture.settled", token: settle.token }));
      await driver.whenIdle();
    }

    expect(driver.debugStateForTests()).toEqual({
      batches: 0,
      cohortTargets: 0,
      anonymousLeaseTargets: 0,
      activeCohorts: 0,
      gestureCohorts: 0,
      recoveries: 0,
    });
  });

  it("disposal cancels timers and fences late lease results and commands", async () => {
    const object = shape("a", 4);
    const coordinator = new CanvasObjectSyncCoordinator();
    const lifecycle = new SemanticCanvasEditLifecycleController(coordinator);
    const harness = new PersistenceHarness(coordinator, roomWith([object]));
    const leases = deferred<{ room: RoomState; leases: readonly ObjectLease[] }>();
    harness.ensureImpl = () => leases.promise;
    const clock = new FakeClock();
    const driver = new SemanticCanvasEditPersistenceDriver(coordinator, harness.host, clock);

    startUpdate(lifecycle, driver, object, draft(object, { x: 90 }));
    expect(clock.pending).toBe(1);
    driver.dispose();
    expect(clock.pending).toBe(0);

    const lease = leaseFor({ objectId: "a", expectedRevision: 4, operation: "move" });
    leases.resolve({ room: harness.room, leases: [lease] });
    clock.advance(10_000);
    await driver.whenIdle();

    expect(harness.commandCalls).toHaveLength(0);
    expect(harness.acknowledgements).toHaveLength(0);
    expect(harness.rollbacks).toHaveLength(0);
    expect(harness.acceptedRooms).toHaveLength(0);
    expect(harness.releaseCalls).toEqual(["batch:cohort"]);
  });
});
