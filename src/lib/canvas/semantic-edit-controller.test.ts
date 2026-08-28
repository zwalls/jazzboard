import { describe, expect, it } from "vitest";

import type {
  CanvasCommand,
  CanvasObject,
  CreateCanvasObject,
  Diagram,
  ObjectLease,
  ObjectLeaseAcquireTarget,
  Participant,
  RoomState,
  SemanticTransaction,
} from "@/lib/domain/types";
import { applySemanticTransaction } from "@/lib/domain/engine";

import {
  SemanticCanvasEditController,
  classifySemanticEditError,
  isSemanticLeaseNotFound,
  type SemanticEditControllerHost,
} from "./semantic-edit-controller";
import {
  SEMANTIC_EDIT_DEBOUNCE_MS,
  SemanticCanvasEditPersistenceDriver,
  type SemanticEditPersistenceClock,
} from "./semantic-edit-persistence";

const actor = {
  participantId: "human-1",
  displayName: "Human",
  color: "#2563eb",
  kind: "human" as const,
};

const self: Participant = {
  ...actor,
  role: "participant",
  joinedAt: 1,
  lastSeenAt: 1,
  connected: true,
  agentActive: false,
  human: { cursor: null, viewport: null, lastSeenAt: 1, activity: null },
  agent: { cursor: null, viewport: null, lastSeenAt: 1, activity: null },
};

type Shape = Extract<CanvasObject, { kind: "shape" }>;
type Text = Extract<CanvasObject, { kind: "text" }>;
type Connector = Extract<CanvasObject, { kind: "connector" }>;

function shape(id: string, x = 10, revision = 1): Shape {
  return {
    id,
    kind: "shape",
    x,
    y: 20,
    width: 120,
    height: 60,
    rotation: 0,
    zIndex: 1,
    revision,
    groupId: null,
    diagramIds: [],
    createdAt: 100,
    updatedAt: 100,
    createdBy: actor,
    lastEditedBy: actor,
    shape: "rectangle",
    nodeType: "decision",
    nodeMetadata: {
      kind: "decision",
      status: "accepted",
      owner: "Team",
      resolution: "Keep the semantic state",
      resolvedAt: 77,
    },
    label: id,
    fill: "#ffffff",
    stroke: "#111827",
  };
}

function textObject(id: string, content = "old", revision = 1): Text {
  return {
    id,
    kind: "text",
    x: 20,
    y: 30,
    width: 180,
    height: 40,
    rotation: 0,
    zIndex: 2,
    revision,
    groupId: null,
    diagramIds: [],
    createdAt: 100,
    updatedAt: 100,
    createdBy: actor,
    lastEditedBy: actor,
    content,
    color: "#111827",
    size: "m",
    align: "start",
  };
}

function connector(id: string, startId: string, endId: string): Connector {
  return {
    id,
    kind: "connector",
    x: 0,
    y: 0,
    width: 100,
    height: 20,
    rotation: 0,
    zIndex: 3,
    revision: 1,
    groupId: null,
    diagramIds: [],
    createdAt: 100,
    updatedAt: 100,
    createdBy: actor,
    lastEditedBy: actor,
    start: { x: 0, y: 0, objectId: startId },
    end: { x: 100, y: 0, objectId: endId },
    routing: { mode: "auto", kind: "straight", bend: 0, elbowMidPoint: 0.5, labelPosition: 0.5 },
    direction: "end",
    label: "uses",
    color: "#111827",
  };
}

function roomWith(objects: readonly CanvasObject[], revision = 1, stateRevision = revision): RoomState {
  return {
    id: "room-1",
    code: "1234",
    title: "Room",
    stateRevision,
    roomRevision: revision,
    createdAt: 1,
    updatedAt: stateRevision,
    participants: { [self.participantId]: self },
    objects: Object.fromEntries(objects.map((object) => [object.id, object])),
    diagrams: {},
    leases: {},
    spotlight: null,
    agentEditPolicy: "live",
    reviewProposals: [],
  };
}

function diagram(id: string, memberObjectIds: string[]): Diagram {
  return {
    id,
    title: "Architecture",
    description: "A semantic container",
    diagramType: "architecture",
    category: "system",
    tags: ["test"],
    memberObjectIds,
    connectorIds: [],
    bounds: { x: 10, y: 20, width: 120, height: 60 },
    revision: 1,
    createdAt: 50,
    updatedAt: 50,
    createdBy: actor,
    lastEditedBy: actor,
  };
}

function draft<ObjectType extends CanvasObject>(object: ObjectType, patch: Partial<ObjectType> = {}): CreateCanvasObject {
  const value = { ...object, ...patch } as Record<string, unknown>;
  for (const key of ["revision", "diagramIds", "createdAt", "updatedAt", "createdBy", "lastEditedBy"]) {
    delete value[key];
  }
  if (value.kind === "shape" && value.nodeMetadata && typeof value.nodeMetadata === "object") {
    const metadata = { ...(value.nodeMetadata as Record<string, unknown>) };
    delete metadata.resolvedAt;
    value.nodeMetadata = metadata;
  }
  return value as CreateCanvasObject;
}

class FakeClock implements SemanticEditPersistenceClock {
  private next = 1;
  private now = 0;
  private timers = new Map<number, { at: number; callback: () => void }>();

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.next++;
    this.timers.set(id, { at: this.now + delayMs, callback });
    return id;
  }

  clearTimeout(timer: number): void {
    this.timers.delete(timer);
  }

  advance(milliseconds: number): void {
    const target = this.now + milliseconds;
    while (true) {
      const entry = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
      if (!entry) break;
      this.timers.delete(entry[0]);
      this.now = entry[1].at;
      entry[1].callback();
    }
    this.now = target;
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function updatedRoom(room: RoomState, commands: readonly CanvasCommand[]): RoomState {
  const next = structuredClone(room);
  for (const command of commands) {
    if (command.type === "create") {
      next.objects[command.object.id] = {
        ...command.object,
        revision: 1,
        diagramIds: [],
        createdAt: 500,
        updatedAt: 500,
        createdBy: actor,
        lastEditedBy: actor,
        ...(command.object.kind === "shape" && command.object.nodeMetadata
          ? { nodeMetadata: { ...command.object.nodeMetadata, resolvedAt: null } }
          : {}),
      } as CanvasObject;
    } else if (command.type === "update") {
      const current = next.objects[command.objectId];
      next.objects[command.objectId] = {
        ...current,
        ...command.patch,
        revision: current.revision + 1,
        updatedAt: 500,
      } as CanvasObject;
    } else if (command.type === "move") {
      for (const target of command.targets) {
        next.objects[target.objectId] = {
          ...next.objects[target.objectId],
          x: target.x,
          y: target.y,
          revision: next.objects[target.objectId].revision + 1,
        };
      }
    } else {
      for (const target of command.targets) delete next.objects[target.objectId];
      for (const diagram of Object.values(next.diagrams)) {
        const members = diagram.memberObjectIds.filter((objectId) => next.objects[objectId]);
        const connectors = diagram.connectorIds.filter((objectId) => next.objects[objectId]?.kind === "connector");
        if (
          members.length !== diagram.memberObjectIds.length ||
          connectors.length !== diagram.connectorIds.length
        ) {
          diagram.memberObjectIds = members;
          diagram.connectorIds = connectors;
          diagram.revision += 1;
        }
      }
    }
  }
  next.roomRevision += 1;
  next.stateRevision = (next.stateRevision ?? 0) + 1;
  return next;
}

class Harness {
  serverRoom: RoomState;
  readonly errors: Array<{ message: string; details: unknown }> = [];
  readonly rollbacks: Array<{ gestureId: string | null; objectIds: readonly string[]; snapshot: RoomState; reason: string }> = [];
  commandImpl: (command: CanvasCommand) => Promise<{ room: RoomState; changedObjectIds: string[] }>;
  refreshImpl: () => Promise<RoomState>;
  controller: SemanticCanvasEditController | null = null;
  failLeaseAcquire = false;
  leaseAcquireAttempts = 0;

  constructor(room: RoomState) {
    this.serverRoom = room;
    this.commandImpl = async (command) => {
      this.serverRoom = updatedRoom(this.serverRoom, [command]);
      return { room: this.serverRoom, changedObjectIds: changedIds([command]) };
    };
    this.refreshImpl = async () => this.serverRoom;
  }

  readonly host: SemanticEditControllerHost = {
    command: (command) => this.commandImpl(command),
    semanticTransaction: async (transaction: SemanticTransaction) => {
      if (transaction.diagramCommands.length) {
        const result = applySemanticTransaction(
          this.serverRoom,
          self.participantId,
          "human",
          transaction,
          500,
        );
        this.serverRoom = result.room;
        return {
          room: result.room,
          changedObjectIds: result.changedObjectIds,
          changedDiagramIds: result.changedDiagramIds,
        };
      }
      this.serverRoom = updatedRoom(this.serverRoom, transaction.commands);
      return { room: this.serverRoom, changedObjectIds: changedIds(transaction.commands) };
    },
    lease: async (action) => {
      if (action.action === "acquire") {
        this.leaseAcquireAttempts += 1;
        if (this.failLeaseAcquire) throw new Error("lease acquire failed");
      }
      if (action.action === "release") {
        const next = structuredClone(this.serverRoom);
        delete next.leases[action.objectId];
        next.stateRevision = (next.stateRevision ?? 0) + 1;
        this.serverRoom = next;
        return { lease: null, room: next };
      }
      const existing = this.serverRoom.leases[action.objectId];
      const lease = action.action === "acquire"
        ? leaseFor(action)
        : { ...existing, expiresAt: existing.expiresAt + 4_000 };
      const next = structuredClone(this.serverRoom);
      next.leases[lease.objectId] = lease;
      next.stateRevision = (next.stateRevision ?? 0) + 1;
      this.serverRoom = next;
      return { lease, room: next };
    },
    leaseMany: async (action) => {
      const targets = action.targets;
      const next = structuredClone(this.serverRoom);
      const leases: ObjectLease[] = [];
      if (action.action === "release-many") {
        for (const target of targets) delete next.leases[target.objectId];
      } else if (action.action === "renew-many") {
        for (const target of targets) {
          const lease = next.leases[target.objectId];
          if (lease) {
            lease.expiresAt += 4_000;
            leases.push(lease);
          }
        }
      } else if (action.action === "acquire-many") {
        for (const target of targets) {
          const lease = leaseFor(target as ObjectLeaseAcquireTarget);
          next.leases[target.objectId] = lease;
          leases.push(lease);
        }
      }
      next.stateRevision = (next.stateRevision ?? 0) + 1;
      this.serverRoom = next;
      return { leases, room: next };
    },
    refresh: () => this.refreshImpl(),
    onError: (message, details) => this.errors.push({ message, details }),
    onRollback: ({ gestureId, objectIds, reason }) => {
      this.rollbacks.push({
        gestureId,
        objectIds,
        reason,
        snapshot: this.controller!.getSnapshot(),
      });
    },
  };
}

function leaseFor(target: ObjectLeaseAcquireTarget): ObjectLease {
  return {
    leaseId: `lease-${target.objectId}`,
    objectId: target.objectId,
    actor,
    operation: target.operation,
    objectRevision: target.expectedRevision,
    acquiredAt: 1,
    expiresAt: 60_000,
  };
}

function changedIds(commands: readonly CanvasCommand[]): string[] {
  return commands.flatMap((command) => {
    if (command.type === "create") return [command.object.id];
    if (command.type === "update") return [command.objectId];
    return command.targets.map((target) => target.objectId);
  });
}

async function microtasks(count = 12): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

function setup(initial: RoomState) {
  const clock = new FakeClock();
  const renderSettles: Array<() => void> = [];
  const harness = new Harness(initial);
  const controller = new SemanticCanvasEditController({
    room: initial,
    self,
    host: harness.host,
    persistenceClock: clock,
    now: () => 400,
    scheduleRenderSettle: (callback) => {
      renderSettles.push(callback);
      return () => {
        const index = renderSettles.indexOf(callback);
        if (index >= 0) renderSettles.splice(index, 1);
      };
    },
  });
  harness.controller = controller;
  return { clock, renderSettles, harness, controller };
}

function startUpdate(
  controller: SemanticCanvasEditController,
  object: CanvasObject,
  next: CreateCanvasObject,
  gestureId = "gesture-1",
  source: "pointer" | "text" | "keyboard" = "pointer",
  operation: "move" | "edit" = "move",
) {
  controller.dispatch({
    type: "gesture.started",
    gestureId,
    source,
    objects: [{ objectId: object.id, baseRevision: object.revision, baseCreatedAt: object.createdAt, operation }],
  });
  controller.dispatch({
    type: "objects.changed",
    gestureId,
    changes: [{
      kind: "update",
      draft: next,
      baseRevision: object.revision,
      baseCreatedAt: object.createdAt,
      operation,
    }],
  });
}

describe("SemanticCanvasEditController", () => {
  it("keeps optimistic move and text pixels across newer stale snapshots", () => {
    const a = shape("a");
    const label = textObject("label");
    const { controller } = setup(roomWith([a, label]));
    startUpdate(controller, a, draft(a, { x: 240 }));
    startUpdate(controller, label, draft(label, { content: "new" }), "text-1", "text", "edit");

    controller.acceptRoom(roomWith([a, label], 1, 8));
    expect(controller.getSnapshot().objects.a.x).toBe(240);
    expect((controller.getSnapshot().objects.label as Text).content).toBe("new");
    controller.dispose();
  });

  it("preserves server-managed node metadata while applying an update draft", () => {
    const decision = shape("decision");
    const { controller } = setup(roomWith([decision]));
    const next = draft(decision, { x: 80 });
    startUpdate(controller, decision, next, "text-1", "text", "edit");

    expect((controller.getSnapshot().objects.decision as Shape).nodeMetadata).toMatchObject({
      resolution: "Keep the semantic state",
      resolvedAt: 77,
    });
    controller.dispose();
  });

  it("clears provisional resolvedAt when semantic workflow fields change", () => {
    const decision = shape("decision");
    const { controller } = setup(roomWith([decision]));
    const next = draft(decision, {
      nodeMetadata: { ...decision.nodeMetadata!, resolution: "Updated", resolvedAt: 999 },
    } as Partial<Shape>);
    startUpdate(controller, decision, next, "text-1", "text", "edit");

    expect((controller.getSnapshot().objects.decision as Shape).nodeMetadata).toMatchObject({
      resolution: "Updated",
      resolvedAt: null,
    });
    controller.dispose();
  });

  it("retains generation N+1 when acknowledgement N arrives", async () => {
    const a = shape("a");
    const { controller, harness, clock } = setup(roomWith([a]));
    const first = deferred<{ room: RoomState; changedObjectIds: string[] }>();
    harness.commandImpl = () => first.promise;
    startUpdate(controller, a, draft(a, { x: 100 }));
    clock.advance(SEMANTIC_EDIT_DEBOUNCE_MS);
    await microtasks();

    controller.dispatch({
      type: "objects.changed",
      gestureId: "gesture-1",
      changes: [{ kind: "update", draft: draft(a, { x: 220 }), baseRevision: 1, baseCreatedAt: a.createdAt, operation: "move" }],
    });
    const ack = updatedRoom(harness.serverRoom, [{ type: "move", targets: [{ objectId: "a", expectedRevision: 1, x: 100, y: a.y, leaseId: "lease-a" }] }]);
    harness.serverRoom = ack;
    first.resolve({ room: ack, changedObjectIds: ["a"] });
    await microtasks(20);

    expect(controller.getSnapshot().objects.a.x).toBe(220);
    controller.dispose();
  });

  it("records history only after the final gesture generation is authoritative", async () => {
    const a = shape("a");
    const { controller, clock, renderSettles } = setup(roomWith([a]));
    startUpdate(controller, a, draft(a, { x: 100 }));

    clock.advance(220);
    await microtasks(20);
    expect(controller.historyState()).toMatchObject({
      undoDepth: 0,
      pendingHumanTransactions: 1,
    });

    controller.dispatch({
      type: "objects.changed",
      gestureId: "gesture-1",
      changes: [{
        kind: "update",
        draft: draft(a, { x: 240 }),
        baseRevision: 1,
        baseCreatedAt: a.createdAt,
        operation: "move",
      }],
    });
    controller.dispatch({ type: "gesture.finish-requested", gestureId: "gesture-1", reason: "pointer-up" });
    renderSettles.shift()!();
    await controller.whenIdle();

    expect(controller.historyState()).toMatchObject({
      undoDepth: 1,
      redoDepth: 0,
      pendingHumanTransactions: 0,
    });
    expect(controller.getAuthoritativeRoom().objects.a.x).toBe(240);
    controller.dispose();
  });

  it("replays undo and redo immediately while moving stacks only after acknowledgement", async () => {
    const a = shape("a");
    const { controller, renderSettles } = setup(roomWith([a]));
    startUpdate(controller, a, draft(a, { x: 180 }));
    controller.dispatch({ type: "gesture.finish-requested", gestureId: "gesture-1", reason: "pointer-up" });
    renderSettles.shift()!();
    await controller.whenIdle();

    const undoStarted = controller.undo();
    expect(controller.getSnapshot().objects.a.x).toBe(10);
    expect(controller.historyState()).toMatchObject({ undoDepth: 1, redoDepth: 0, replayPending: true });
    expect(await undoStarted).toBe(true);
    renderSettles.shift()!();
    await controller.whenIdle();
    expect(controller.historyState()).toMatchObject({ undoDepth: 0, redoDepth: 1, replayPending: false });

    const redoStarted = controller.redo();
    expect(controller.getSnapshot().objects.a.x).toBe(180);
    expect(await redoStarted).toBe(true);
    renderSettles.shift()!();
    await controller.whenIdle();
    expect(controller.historyState()).toMatchObject({ undoDepth: 1, redoDepth: 0, replayPending: false });
    controller.dispose();
  });

  it("restores deleted object and Diagram membership atomically during undo", async () => {
    const member = { ...shape("member"), diagramIds: ["diagram-1"] };
    const initial = roomWith([member]);
    initial.diagrams["diagram-1"] = diagram("diagram-1", ["member"]);
    const { controller, renderSettles, harness } = setup(initial);

    controller.dispatch({
      type: "gesture.started",
      gestureId: "delete-member",
      source: "keyboard",
      objects: [{ objectId: member.id, baseRevision: member.revision, baseCreatedAt: member.createdAt, operation: "delete" }],
    });
    controller.dispatch({
      type: "objects.changed",
      gestureId: "delete-member",
      changes: [{ kind: "delete", objectId: member.id, baseRevision: member.revision, baseCreatedAt: member.createdAt, operation: "delete" }],
    });
    controller.dispatch({ type: "gesture.finish-requested", gestureId: "delete-member", reason: "keyboard-idle" });
    renderSettles.shift()!();
    await controller.whenIdle();
    expect(harness.serverRoom.diagrams["diagram-1"].memberObjectIds).toEqual([]);

    expect(await controller.undo()).toBe(true);
    expect(controller.getSnapshot().objects.member).toBeDefined();
    renderSettles.shift()!();
    await controller.whenIdle();
    expect(harness.serverRoom.objects.member.diagramIds).toEqual(["diagram-1"]);
    expect(harness.serverRoom.diagrams["diagram-1"].memberObjectIds).toEqual(["member"]);
    expect(controller.historyState()).toMatchObject({ undoDepth: 0, redoDepth: 1 });
    controller.dispose();
  });

  it("rejects a failed undo replay without consuming the history entry", async () => {
    const a = shape("a");
    const { controller, renderSettles, harness } = setup(roomWith([a]));
    startUpdate(controller, a, draft(a, { x: 200 }));
    controller.dispatch({ type: "gesture.finish-requested", gestureId: "gesture-1", reason: "pointer-up" });
    renderSettles.shift()!();
    await controller.whenIdle();

    harness.commandImpl = async () => {
      throw Object.assign(new Error("conflict"), { code: "REVISION_CONFLICT" });
    };
    expect(await controller.undo()).toBe(true);
    renderSettles.shift()!();
    await controller.whenIdle();
    expect(controller.historyState()).toMatchObject({ undoDepth: 1, redoDepth: 0, replayPending: false });
    expect(controller.getSnapshot().objects.a.x).toBe(200);
    controller.dispose();
  });

  it("blocks target-null Diagram restoration without consuming history", async () => {
    const a = shape("a");
    const { controller, renderSettles, harness } = setup(roomWith([a]));
    harness.commandImpl = async (command) => {
      const next = updatedRoom(harness.serverRoom, [command]);
      next.diagrams["diagram-created-elsewhere"] = diagram("diagram-created-elsewhere", ["a"]);
      next.objects.a.diagramIds = ["diagram-created-elsewhere"];
      harness.serverRoom = next;
      return { room: next, changedObjectIds: ["a"] };
    };
    startUpdate(controller, a, draft(a, { x: 90 }));
    controller.dispatch({ type: "gesture.finish-requested", gestureId: "gesture-1", reason: "pointer-up" });
    renderSettles.shift()!();
    await controller.whenIdle();

    await expect(controller.undo()).rejects.toMatchObject({ code: "STALE_REPLAY" });
    expect(controller.historyState()).toMatchObject({ undoDepth: 1, redoDepth: 0, replayPending: false });
    controller.dispose();
  });

  it("rejects history for a fully-overlapped recovery that has no rollback callback", async () => {
    const a = shape("a");
    const { controller, harness } = setup(roomWith([a]));
    const firstRefresh = deferred<RoomState>();
    let refreshCalls = 0;
    harness.refreshImpl = async () => {
      refreshCalls += 1;
      return refreshCalls === 1 ? firstRefresh.promise : harness.serverRoom;
    };
    startUpdate(controller, a, draft(a, { x: 100 }), "recover-a");
    startUpdate(controller, a, draft(a, { x: 200 }), "recover-b");
    await microtasks();

    const persistence = (controller as unknown as {
      persistence: SemanticCanvasEditPersistenceDriver;
    }).persistence;
    const recoveryA = persistence.recoverLeaseCohort({
      cohortId: "recover-a",
      objectIds: ["a"],
      cause: new Error("first cohort failed"),
    });
    const recoveryB = persistence.recoverLeaseCohort({
      cohortId: "recover-b",
      objectIds: ["a"],
      cause: new Error("fully overlapped cohort failed"),
    });
    firstRefresh.resolve(harness.serverRoom);
    await Promise.all([recoveryA, recoveryB]);

    expect(harness.rollbacks).toHaveLength(1);
    expect(harness.rollbacks[0]).toMatchObject({
      gestureId: "recover-a",
      objectIds: ["a"],
    });
    expect(controller.historyState()).toMatchObject({
      undoDepth: 0,
      redoDepth: 0,
      pendingHumanTransactions: 0,
      replayPending: false,
    });
    controller.dispose();
  });

  it("unregisters Diagram restoration when replay dispatch fails synchronously", async () => {
    const member = { ...shape("member"), diagramIds: ["diagram-1"] };
    const other = shape("other", 300);
    const initial = roomWith([member, other]);
    initial.diagrams["diagram-1"] = diagram("diagram-1", ["member"]);
    const { controller, renderSettles, harness } = setup(initial);

    controller.dispatch({
      type: "gesture.started",
      gestureId: "delete-member",
      source: "keyboard",
      objects: [{ objectId: member.id, baseRevision: member.revision, baseCreatedAt: member.createdAt, operation: "delete" }],
    });
    controller.dispatch({
      type: "objects.changed",
      gestureId: "delete-member",
      changes: [{ kind: "delete", objectId: member.id, baseRevision: member.revision, baseCreatedAt: member.createdAt, operation: "delete" }],
    });
    controller.dispatch({ type: "gesture.finish-requested", gestureId: "delete-member", reason: "keyboard-idle" });
    renderSettles.shift()!();
    await controller.whenIdle();
    expect(harness.serverRoom.diagrams["diagram-1"].memberObjectIds).toEqual([]);

    const replayId = "history:undo:1:1:delete-member";
    controller.dispatch({
      type: "gesture.started",
      gestureId: replayId,
      source: "pointer",
      objects: [{ objectId: other.id, baseRevision: other.revision, baseCreatedAt: other.createdAt, operation: "move" }],
    });
    await expect(controller.undo()).rejects.toThrow(`Canvas gesture ${replayId} is already active.`);

    controller.dispatch({
      type: "objects.changed",
      gestureId: replayId,
      changes: [{ kind: "update", draft: draft(other, { x: 420 }), baseRevision: other.revision, baseCreatedAt: other.createdAt, operation: "move" }],
    });
    controller.dispatch({ type: "gesture.finish-requested", gestureId: replayId, reason: "pointer-up" });
    renderSettles.shift()!();
    await controller.whenIdle();

    expect(harness.serverRoom.objects.other.x).toBe(420);
    expect(harness.serverRoom.diagrams["diagram-1"].memberObjectIds).toEqual([]);
    expect(controller.historyState().replayPending).toBe(false);
    controller.dispose();
  });

  it("exposes dynamically protected connector routes", () => {
    const a = shape("a");
    const b = shape("b", 400);
    const edge = connector("edge", "a", "b");
    const { controller } = setup(roomWith([a, b, edge]));
    controller.dispatch({
      type: "gesture.started",
      gestureId: "move-a",
      source: "pointer",
      objects: [{ objectId: "a", baseRevision: 1, baseCreatedAt: a.createdAt, operation: "move" }],
    });
    controller.dispatch({
      type: "gesture.dependencies-added",
      gestureId: "move-a",
      objects: [{ objectId: "edge", baseRevision: 1, baseCreatedAt: edge.createdAt, operation: "move" }],
    });
    expect(controller.optimisticConnectorIds()).toEqual(new Set(["edge"]));
    expect(controller.isProjectionAuthoritative("a")).toBe(false);
    expect(controller.isProjectionAuthoritative("edge")).toBe(false);
    controller.dispose();
  });

  it("drains a finished edit, refreshes authority, and returns an exact Ask snapshot", async () => {
    const a = shape("a");
    const { controller, harness, renderSettles } = setup(roomWith([a]));
    let refreshCalls = 0;
    harness.refreshImpl = async () => {
      refreshCalls += 1;
      return harness.serverRoom;
    };
    startUpdate(controller, a, draft(a, { x: 260 }));
    controller.dispatch({
      type: "gesture.finish-requested",
      gestureId: "gesture-1",
      reason: "pointer-up",
    });
    renderSettles.shift()!();
    const authoritative = await controller.flushAndDrain(["a"]);

    expect(refreshCalls).toBe(1);
    expect(authoritative.objects.a).toMatchObject({ x: 260, revision: 2 });
    expect(controller.getSnapshot().objects.a).toBe(authoritative.objects.a);
    expect(controller.isProjectionAuthoritative("a")).toBe(true);
    controller.dispose();
  });

  it("projects provisional creates and deletion tombstones synchronously", () => {
    const a = shape("a");
    const { controller } = setup(roomWith([a]));
    const created = draft(shape("new", 300));
    controller.dispatch({
      type: "objects.changed",
      gestureId: null,
      changes: [{ kind: "create", draft: created, baseRevision: null, baseCreatedAt: null }],
    });
    expect(controller.getSnapshot().objects.new).toMatchObject({
      id: "new",
      revision: 0,
      createdAt: 400,
      createdBy: actor,
    });

    controller.dispatch({
      type: "objects.changed",
      gestureId: null,
      changes: [{ kind: "delete", objectId: "a", baseRevision: 1, baseCreatedAt: a.createdAt, operation: "delete" }],
    });
    expect(controller.getSnapshot().objects.a).toBeUndefined();
    controller.acceptRoom(roomWith([a], 1, 9));
    expect(controller.getSnapshot().objects.a).toBeUndefined();
    controller.dispose();
  });

  it("waits one injected render boundary before final persistence", async () => {
    const a = shape("a");
    const { controller, renderSettles, harness } = setup(roomWith([a]));
    startUpdate(controller, a, draft(a, { x: 160 }));
    controller.dispatch({ type: "gesture.finish-requested", gestureId: "gesture-1", reason: "pointer-up" });
    expect(renderSettles).toHaveLength(1);
    expect(harness.serverRoom.objects.a.x).toBe(10);
    renderSettles.shift()!();
    await controller.whenIdle();
    expect(harness.serverRoom.objects.a.x).toBe(160);
    controller.dispose();
  });

  it("reports a confirmed server failure while refresh is gated, then rolls back without a duplicate", async () => {
    const a = shape("a");
    const { controller, harness, renderSettles } = setup(roomWith([a]));
    const refresh = deferred<RoomState>();
    const failure = Object.assign(new Error(""), {
      failure: {
        code: "INTERNAL_ERROR",
        message: "Injected older save failure.",
      },
    });
    harness.commandImpl = async () => { throw failure; };
    harness.refreshImpl = () => refresh.promise;
    startUpdate(controller, a, draft(a, { x: 200 }));
    controller.dispatch({ type: "gesture.finish-requested", gestureId: "gesture-1", reason: "pointer-up" });
    renderSettles.shift()!();
    await microtasks();

    expect(harness.errors).toEqual([{
      message: "Injected older save failure.",
      details: failure,
    }]);
    expect(harness.rollbacks).toHaveLength(0);
    expect(controller.getSnapshot().objects.a.x).toBe(200);

    refresh.resolve(harness.serverRoom);
    await controller.whenIdle();

    expect(harness.rollbacks).toHaveLength(1);
    expect(harness.rollbacks[0].gestureId).toBe("gesture-1");
    expect(harness.rollbacks[0].snapshot.objects.a.x).toBe(10);
    // The recovery completion must not repeat the already-visible failure.
    expect(harness.errors).toHaveLength(1);
    expect(controller.getSnapshot().objects.a.x).toBe(10);
    expect(controller.historyState()).toMatchObject({
      undoDepth: 0,
      redoDepth: 0,
      pendingHumanTransactions: 0,
    });
    controller.dispose();
  });

  it("force-recovers every member of an overlapping gesture in one projection boundary", async () => {
    const a = shape("a", 10);
    const b = shape("b", 300);
    const { controller, harness, clock } = setup(roomWith([a, b]));
    const olderSave = deferred<{ room: RoomState; changedObjectIds: string[] }>();
    const refresh = deferred<RoomState>();
    const failure = new Error("older A save failed");
    harness.commandImpl = () => olderSave.promise;
    harness.refreshImpl = () => refresh.promise;

    startUpdate(controller, a, draft(a, { x: 100 }), "older-a");
    clock.advance(220);
    await microtasks();
    expect(harness.serverRoom.objects.a.x).toBe(10);

    controller.dispatch({
      type: "gesture.started",
      gestureId: "newer-a-b",
      source: "pointer",
      objects: [a, b].map((object) => ({
        objectId: object.id,
        baseRevision: object.revision,
        baseCreatedAt: object.createdAt,
        operation: "move" as const,
      })),
    });
    controller.dispatch({
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
    });
    expect([
      controller.getSnapshot().objects.a.x,
      controller.getSnapshot().objects.b.x,
    ]).toEqual([190, 390]);

    const projectedPositions: Array<readonly [number, number]> = [];
    const unsubscribe = controller.subscribe(() => {
      projectedPositions.push([
        controller.getSnapshot().objects.a.x,
        controller.getSnapshot().objects.b.x,
      ]);
    });

    olderSave.reject(failure);
    await microtasks(20);
    expect(harness.errors).toEqual([{ message: failure.message, details: failure }]);
    expect(harness.rollbacks).toHaveLength(0);

    refresh.resolve(harness.serverRoom);
    await controller.whenIdle();
    unsubscribe();

    expect(harness.rollbacks).toHaveLength(1);
    expect(harness.rollbacks[0]).toMatchObject({
      gestureId: "older-a",
      objectIds: ["a", "b"],
    });
    expect(harness.rollbacks[0].snapshot.objects).toMatchObject({
      a: { x: 10 },
      b: { x: 300 },
    });
    expect(projectedPositions).not.toContainEqual([10, 390]);
    expect(projectedPositions).not.toContainEqual([190, 300]);
    expect(projectedPositions).toContainEqual([10, 300]);
    expect(controller.isProjectionAuthoritative("a")).toBe(true);
    expect(controller.isProjectionAuthoritative("b")).toBe(true);
    controller.dispose();
  });

  it("cancels text through recovery without showing an error", async () => {
    const label = textObject("label");
    const { controller, harness } = setup(roomWith([label]));
    startUpdate(controller, label, draft(label, { content: "draft" }), "text-1", "text", "edit");
    controller.dispatch({ type: "gesture.cancel-requested", gestureId: "text-1", reason: "text-cancel" });
    await controller.whenIdle();

    expect((controller.getSnapshot().objects.label as Text).content).toBe("old");
    expect(harness.rollbacks[0].reason).toBe("cancelled");
    expect(harness.errors).toHaveLength(0);
    expect(controller.historyState()).toMatchObject({
      undoDepth: 0,
      redoDepth: 0,
      pendingHumanTransactions: 0,
    });
    expect(controller.dispatch({ type: "gesture.finish-requested", gestureId: "text-1", reason: "text-blur" })).toEqual([]);
    controller.dispose();
  });

  it("classifies API-shaped committed replays and missing leases", () => {
    expect(classifySemanticEditError({
      failure: {
        code: "MUTATION_OUTCOME_UNKNOWN",
        details: { replayed: true, committedRoomRevision: 9 },
      },
    })).toEqual({ kind: "committed-replay", committedRoomRevision: 9 });
    expect(classifySemanticEditError({ code: "MUTATION_OUTCOME_UNKNOWN", details: { replayed: false } }))
      .toEqual({ kind: "confirmed-failure" });
    expect(isSemanticLeaseNotFound({ failure: { code: "LEASE_NOT_FOUND" } })).toBe(true);
  });

  it("reconciles a committed replay without rollback", async () => {
    const a = shape("a");
    const { controller, harness, renderSettles } = setup(roomWith([a]));
    harness.commandImpl = async (command) => {
      harness.serverRoom = updatedRoom(harness.serverRoom, [command]);
      throw {
        failure: {
          code: "MUTATION_OUTCOME_UNKNOWN",
          message: "response lost",
          details: { replayed: true, committedRoomRevision: harness.serverRoom.roomRevision },
        },
      };
    };
    startUpdate(controller, a, draft(a, { x: 330 }));
    controller.dispatch({ type: "gesture.finish-requested", gestureId: "gesture-1", reason: "pointer-up" });
    renderSettles.shift()!();
    await controller.whenIdle();

    expect(controller.getSnapshot().objects.a.x).toBe(330);
    expect(harness.rollbacks).toHaveLength(0);
    expect(harness.errors).toHaveLength(0);
    controller.dispose();
  });

  it("queues the newest debounced keyboard generation before disposal and fences its acknowledgement", async () => {
    const a = shape("a");
    const { controller, harness } = setup(roomWith([a]));
    const gate = deferred<{ room: RoomState; changedObjectIds: string[] }>();
    let submitted: CanvasCommand | null = null;
    harness.commandImpl = (command) => {
      submitted = command;
      return gate.promise;
    };

    startUpdate(controller, a, draft(a, { x: 100 }), "keyboard-a", "keyboard");
    controller.dispatch({
      type: "objects.changed",
      gestureId: "keyboard-a",
      changes: [{
        kind: "update",
        draft: draft(a, { x: 240 }),
        baseRevision: a.revision,
        baseCreatedAt: a.createdAt,
        operation: "move",
      }],
    });
    controller.dispatch({
      type: "gesture.finish-requested",
      gestureId: "keyboard-a",
      reason: "keyboard-idle",
    });

    let lateNotifications = 0;
    const unsubscribe = controller.subscribe(() => { lateNotifications += 1; });
    controller.dispose();
    lateNotifications = 0;
    await microtasks(20);

    expect(submitted).toMatchObject({
      type: "move",
      targets: [expect.objectContaining({ objectId: "a", x: 240 })],
    });
    const acknowledged = updatedRoom(harness.serverRoom, [submitted!]);
    harness.serverRoom = acknowledged;
    gate.resolve({ room: acknowledged, changedObjectIds: ["a"] });
    await controller.whenIdle();
    await microtasks(20);

    expect(harness.serverRoom.objects.a).toMatchObject({ x: 240, revision: 2 });
    expect(harness.serverRoom.leases).toEqual({});
    expect(harness.errors).toHaveLength(0);
    expect(harness.rollbacks).toHaveLength(0);
    expect(lateNotifications).toBe(0);
    unsubscribe();
  });

  it("does not retry or recover a failed shutdown mutation", async () => {
    const a = shape("a");
    const { controller, harness } = setup(roomWith([a]));
    let attempts = 0;
    let refreshes = 0;
    harness.commandImpl = async () => {
      attempts += 1;
      throw new Error("shutdown transport failed");
    };
    harness.refreshImpl = async () => {
      refreshes += 1;
      return harness.serverRoom;
    };

    startUpdate(controller, a, draft(a, { x: 240 }), "keyboard-a", "keyboard");
    controller.dispatch({
      type: "gesture.finish-requested",
      gestureId: "keyboard-a",
      reason: "keyboard-idle",
    });
    controller.dispose();
    await controller.whenIdle();
    await microtasks(20);

    expect(attempts).toBe(1);
    expect(refreshes).toBe(0);
    expect(harness.errors).toHaveLength(0);
    expect(harness.rollbacks).toHaveLength(0);
    expect(harness.serverRoom.leases).toEqual({});
  });

  it("does not recover a lease acquisition that fails after shutdown begins", async () => {
    const a = shape("a");
    const { controller, harness } = setup(roomWith([a]));
    let refreshes = 0;
    harness.failLeaseAcquire = true;
    harness.refreshImpl = async () => {
      refreshes += 1;
      return harness.serverRoom;
    };

    startUpdate(controller, a, draft(a, { x: 240 }), "keyboard-a", "keyboard");
    controller.dispatch({
      type: "gesture.finish-requested",
      gestureId: "keyboard-a",
      reason: "keyboard-idle",
    });
    controller.dispose();
    await controller.whenIdle();
    await microtasks(20);

    expect(harness.leaseAcquireAttempts).toBe(1);
    expect(refreshes).toBe(0);
    expect(harness.errors).toHaveLength(0);
    expect(harness.rollbacks).toHaveLength(0);
  });

  it("fences pending render and network callbacks after disposal", async () => {
    const a = shape("a");
    const { controller, harness, renderSettles, clock } = setup(roomWith([a]));
    const command = deferred<{ room: RoomState; changedObjectIds: string[] }>();
    harness.commandImpl = () => command.promise;
    startUpdate(controller, a, draft(a, { x: 500 }));
    controller.dispatch({ type: "gesture.finish-requested", gestureId: "gesture-1", reason: "pointer-up" });
    const lateSettle = renderSettles[0];
    controller.dispose();
    lateSettle?.();
    clock.advance(10_000);
    command.resolve({ room: updatedRoom(harness.serverRoom, []), changedObjectIds: [] });
    await microtasks();

    expect(controller.dispatch({
      type: "objects.changed",
      gestureId: null,
      changes: [{ kind: "create", draft: draft(shape("late")), baseRevision: null, baseCreatedAt: null }],
    })).toEqual([]);
    expect(controller.optimisticConnectorIds()).toEqual(new Set());
  });
});
