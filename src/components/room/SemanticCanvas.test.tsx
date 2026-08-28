import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CanvasRuntime } from "@/lib/canvas/runtime";
import { SEMANTIC_CANVAS_CLIPBOARD_FORMAT } from "@/lib/canvas/semantic-keyboard-session";
import {
  ACTIVE_PRESENCE_KEYFRAME_MS,
  TRANSIENT_PRESENCE_INTERVAL_MS,
} from "@/lib/client/presence-cadence";
import type {
  CanvasCommand,
  CanvasObject,
  ObjectLease,
  ObjectLeaseAcquireTarget,
  Participant,
  RoomState,
  SemanticTransaction,
} from "@/lib/domain/types";

import type { SemanticCanvasEditingHost } from "./canvas-surface-types";
import { SemanticCanvas } from "./SemanticCanvas";

const actor = {
  participantId: "spectator-1",
  displayName: "Sam",
  color: "#5965e8",
  kind: "human" as const,
};

const self: Participant = {
  participantId: "spectator-1",
  displayName: "Sam",
  color: "#5965e8",
  role: "spectator",
  joinedAt: 1,
  lastSeenAt: 1,
  connected: true,
  agentActive: false,
  human: { cursor: null, viewport: null, lastSeenAt: 1, activity: null },
  agent: { cursor: null, viewport: null, lastSeenAt: 1, activity: null },
};

const room: RoomState = {
  id: "room-1",
  code: "1234",
  title: "Semantic test board",
  roomRevision: 3,
  createdAt: 1,
  updatedAt: 2,
  participants: { [self.participantId]: self },
  objects: {
    "node-a": {
      id: "node-a",
      kind: "shape",
      x: 100,
      y: 100,
      width: 180,
      height: 80,
      rotation: 0,
      zIndex: 1,
      revision: 1,
      groupId: "group-1",
      diagramIds: [],
      createdAt: 1,
      updatedAt: 2,
      createdBy: actor,
      lastEditedBy: actor,
      shape: "rectangle",
      nodeType: "service",
      label: "Room API",
      fill: "light-violet",
      stroke: "blue",
    },
    "node-b": {
      id: "node-b",
      kind: "text",
      x: 320,
      y: 100,
      width: 180,
      height: 80,
      rotation: 0,
      zIndex: 2,
      revision: 1,
      groupId: "group-1",
      diagramIds: [],
      createdAt: 1,
      updatedAt: 2,
      createdBy: actor,
      lastEditedBy: actor,
      content: "Authorized guest",
      color: "black",
      size: "m",
      align: "middle",
    },
  },
  diagrams: {},
  leases: {},
  spotlight: null,
  agentEditPolicy: "live",
  reviewProposals: [],
};

const menuActions = {
  askPreparing: false,
  pendingReviewCount: 0,
  selectionCount: 0,
  onActivity: vi.fn(),
  onAsk: vi.fn(),
  onCanvasOutline: vi.fn(),
  onExport: vi.fn(),
  onReview: vi.fn(),
  onUpgradeRole: vi.fn(),
};

class TestResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    this.callback([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  disconnect() {}
  unobserve() {}
}

function renderCanvas(
  onRuntimeChange = vi.fn<(runtime: CanvasRuntime | null) => void>(),
  renderedSelf: Participant = self,
) {
  const onSelectionChange = vi.fn();
  const presence = vi.fn().mockResolvedValue(undefined);
  const transientPresence = vi.fn(() => true);
  render(
    <SemanticCanvas
      boardMenuActions={menuActions}
      room={{ ...room, participants: { [renderedSelf.participantId]: renderedSelf } }}
      self={renderedSelf}
      followTarget={null}
      presence={presence}
      transientPresence={transientPresence}
      connection="live"
      onSelectionChange={onSelectionChange}
      onRuntimeChange={onRuntimeChange}
      onExitFollow={vi.fn()}
    />,
  );
  return { onRuntimeChange, onSelectionChange, presence, transientPresence };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function leaseFor(target: ObjectLeaseAcquireTarget): ObjectLease {
  return {
    leaseId: `lease-${target.objectId}`,
    objectId: target.objectId,
    actor,
    operation: target.operation,
    objectRevision: target.expectedRevision,
    acquiredAt: 10,
    expiresAt: 60_000,
  };
}

function applyCommand(source: RoomState, command: CanvasCommand): RoomState {
  const next = structuredClone(source);
  if (command.type === "create") {
    const now = Math.max(10, source.updatedAt + 1);
    next.objects[command.object.id] = {
      ...command.object,
      revision: 1,
      diagramIds: [],
      createdAt: now,
      updatedAt: now,
      createdBy: actor,
      lastEditedBy: actor,
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
  } else if (command.type === "update") {
    const current = next.objects[command.objectId];
    next.objects[command.objectId] = {
      ...current,
      ...command.patch,
      revision: current.revision + 1,
    } as typeof current;
  }
  next.roomRevision += 1;
  next.stateRevision = (next.stateRevision ?? next.roomRevision) + 1;
  return next;
}

function requireCreateCommand(command: CanvasCommand | null): Extract<CanvasCommand, { type: "create" }> {
  if (!command || command.type !== "create") throw new Error("Expected a create command.");
  return command;
}

function makeEditingHarness(
  initialRoom: RoomState,
  commandImpl?: SemanticCanvasEditingHost["command"],
) {
  let serverRoom = structuredClone(initialRoom);
  const onError = vi.fn();
  const command = vi.fn<SemanticCanvasEditingHost["command"]>(async (...args) => {
    if (commandImpl) return commandImpl(...args);
    serverRoom = applyCommand(serverRoom, args[0]);
    return { room: serverRoom, changedObjectIds: [] };
  });
  const editing: SemanticCanvasEditingHost = {
    command,
    semanticTransaction: vi.fn(async (transaction) => {
      for (const nextCommand of transaction.commands) serverRoom = applyCommand(serverRoom, nextCommand);
      return { room: serverRoom, changedObjectIds: [], changedDiagramIds: [], membershipObjectIds: [] };
    }),
    lease: vi.fn(async (action) => {
      const next = structuredClone(serverRoom);
      let lease: ObjectLease | null = null;
      if (action.action === "release") delete next.leases[action.objectId];
      else if (action.action === "acquire") {
        lease = leaseFor(action);
        next.leases[action.objectId] = lease;
      } else {
        lease = next.leases[action.objectId] ?? null;
        if (lease) lease.expiresAt += 4_000;
      }
      next.stateRevision = (next.stateRevision ?? next.roomRevision) + 1;
      serverRoom = next;
      return { lease, room: next };
    }),
    leaseMany: vi.fn(async (action) => {
      const next = structuredClone(serverRoom);
      const leases: ObjectLease[] = [];
      if (action.action === "acquire-many") {
        for (const target of action.targets) {
          const lease = leaseFor(target);
          leases.push(lease);
          next.leases[target.objectId] = lease;
        }
      } else if (action.action === "renew-many") {
        for (const target of action.targets) {
          const lease = next.leases[target.objectId];
          if (lease) {
            lease.expiresAt += 4_000;
            leases.push(lease);
          }
        }
      } else {
        for (const target of action.targets) delete next.leases[target.objectId];
      }
      next.stateRevision = (next.stateRevision ?? next.roomRevision) + 1;
      serverRoom = next;
      return { leases, room: next };
    }),
    refresh: vi.fn(async () => serverRoom),
    onError,
  };
  return {
    editing,
    command,
    onError,
    getServerRoom: () => serverRoom,
    setServerRoom: (next: RoomState) => { serverRoom = next; },
  };
}

function renderEditableCanvas(
  editableRoom: RoomState,
  editing: SemanticCanvasEditingHost,
  renderedSelf: Participant = { ...self, role: "participant" },
) {
  let runtime: CanvasRuntime | null = null;
  const onRuntimeChange = vi.fn((next: CanvasRuntime | null) => { runtime = next; });
  const onSelectionChange = vi.fn();
  const props = {
    boardMenuActions: menuActions,
    self: renderedSelf,
    followTarget: null,
    presence: vi.fn().mockResolvedValue(undefined),
    transientPresence: vi.fn(() => true),
    connection: "live" as const,
    onSelectionChange,
    onRuntimeChange,
    onExitFollow: vi.fn(),
    editing,
  } as const;
  const result = render(<SemanticCanvas {...props} room={editableRoom} />);
  return {
    ...result,
    getRuntime: () => runtime,
    onSelectionChange,
    rerenderRoom(nextRoom: RoomState, nextEditing = editing) {
      result.rerender(<SemanticCanvas {...props} room={nextRoom} editing={nextEditing} />);
    },
  };
}

function installPointerCapture(element: HTMLElement) {
  const setPointerCapture = vi.fn();
  const hasPointerCapture = vi.fn(() => true);
  const releasePointerCapture = vi.fn();
  Object.defineProperties(element, {
    setPointerCapture: { configurable: true, value: setPointerCapture },
    hasPointerCapture: { configurable: true, value: hasPointerCapture },
    releasePointerCapture: { configurable: true, value: releasePointerCapture },
  });
  return { setPointerCapture, hasPointerCapture, releasePointerCapture };
}

function clientPointForPage(runtime: CanvasRuntime, x: number, y: number) {
  const viewport = runtime.getViewport();
  return {
    clientX: (x - viewport.x) * viewport.zoom,
    clientY: (y - viewport.y) * viewport.zoom,
  };
}

function semanticObject(kind: CanvasObject["kind"], excludeId?: string): SVGGElement {
  const match = [...document.querySelectorAll<SVGGElement>(`[data-object-kind="${kind}"]`)]
    .find((element) => element.dataset.objectId !== excludeId);
  if (!match) throw new Error(`Expected a semantic ${kind} object.`);
  return match;
}

async function flushMicrotasks(count = 16) {
  await act(async () => {
    for (let index = 0; index < count; index += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 800,
    bottom: 600,
    width: 800,
    height: 600,
    toJSON: () => ({}),
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("SemanticCanvas", () => {
  it("publishes a read-only semantic runtime and renders authoritative objects", async () => {
    const { onRuntimeChange } = renderCanvas();

    expect(screen.getByTestId("semantic-canvas")).toHaveAttribute("data-canvas-renderer", "jazzboard-semantic-v1");
    expect(screen.getByRole("button", { name: /service: Room API/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Text: Authorized guest/i })).toBeInTheDocument();

    await waitFor(() => expect(onRuntimeChange).toHaveBeenCalledWith(expect.objectContaining({
      rendererId: "jazzboard-semantic-v1",
      capabilities: { renderPng: true },
    })));
  });

  it("reuses the semantic scene for presence-only room envelopes and invalidates it for document edits", async () => {
    let runtime: CanvasRuntime | null = null;
    const props = {
      boardMenuActions: menuActions,
      self,
      followTarget: null,
      presence: vi.fn().mockResolvedValue(undefined),
      transientPresence: vi.fn(() => true),
      connection: "live" as const,
      onSelectionChange: vi.fn(),
      onRuntimeChange: vi.fn((next: CanvasRuntime | null) => { runtime = next; }),
      onExitFollow: vi.fn(),
    };
    const rendered = render(<SemanticCanvas {...props} room={room} />);
    await waitFor(() => expect(runtime).not.toBeNull());
    const onDocumentChange = vi.fn();
    const unsubscribe = runtime!.onDocumentChange(onDocumentChange);

    const presenceOnly = structuredClone(room);
    presenceOnly.stateRevision = 4;
    presenceOnly.participants[self.participantId]!.lastSeenAt += 1;
    rendered.rerender(<SemanticCanvas {...props} room={presenceOnly} />);
    expect(onDocumentChange).not.toHaveBeenCalled();

    const edited = structuredClone(presenceOnly);
    edited.stateRevision = 5;
    edited.roomRevision += 1;
    edited.objects["node-a"] = {
      ...edited.objects["node-a"]!,
      revision: edited.objects["node-a"]!.revision + 1,
      label: "Updated room API",
    } as CanvasObject;
    rendered.rerender(<SemanticCanvas {...props} room={edited} />);
    expect(onDocumentChange).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: /service: Updated room API/i })).toBeInTheDocument();
    unsubscribe();
  });

  it("uses one roving object tab stop with deterministic spectator inspection", async () => {
    const { onSelectionChange } = renderCanvas();
    const first = screen.getByRole("button", { name: /service: Room API/i });
    const second = screen.getByRole("button", { name: /Text: Authorized guest/i });

    expect([first, second].filter((object) => object.tabIndex === 0)).toEqual([first]);
    first.focus();
    fireEvent.keyDown(first, { key: "Tab" });
    await flushMicrotasks();
    expect(second).toHaveFocus();
    expect(second).toHaveAttribute("tabindex", "0");
    expect(first).toHaveAttribute("tabindex", "-1");

    fireEvent.keyDown(second, { key: "Tab", shiftKey: true });
    await flushMicrotasks();
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "ArrowUp" });
    await flushMicrotasks();
    expect(second).toHaveFocus();
    fireEvent.keyDown(second, { key: "Enter" });
    expect(onSelectionChange).toHaveBeenLastCalledWith(["node-a", "node-b"]);
  });

  it("focuses programmatic selections and a deterministic survivor after deletion", async () => {
    const deletion = deferred<{ room: RoomState; changedObjectIds: string[] }>();
    const ungrouped = structuredClone(room);
    ungrouped.objects["node-a"]!.groupId = null;
    ungrouped.objects["node-b"]!.groupId = null;
    const harness = makeEditingHarness(ungrouped, async () => deletion.promise);
    const rendered = renderEditableCanvas(ungrouped, harness.editing);
    rendered.getRuntime()!.selectObjects(["node-a"]);
    await flushMicrotasks();
    const first = screen.getByRole("button", { name: /service: Room API/i });
    const second = screen.getByRole("button", { name: /Text: Authorized guest/i });
    expect(first).toHaveFocus();

    fireEvent.keyDown(first, { key: "Delete" });
    await flushMicrotasks();
    expect(screen.queryByRole("button", { name: /service: Room API/i })).toBeNull();
    expect(second).toHaveFocus();
    expect(second).toHaveAttribute("tabindex", "0");
  });

  it("preserves compact room identity and accessible board-menu parity", async () => {
    const participantSelf: Participant = { ...self, role: "participant" };
    const countedActions = {
      ...menuActions,
      askPreparing: true,
      pendingReviewCount: 3,
      selectionCount: 2,
    };
    render(
      <SemanticCanvas
        boardMenuActions={countedActions}
        room={{ ...room, participants: { [participantSelf.participantId]: participantSelf } }}
        self={participantSelf}
        followTarget={null}
        presence={vi.fn().mockResolvedValue(undefined)}
        transientPresence={vi.fn(() => true)}
        connection="live"
        onSelectionChange={vi.fn()}
        onRuntimeChange={vi.fn()}
        onExitFollow={vi.fn()}
      />,
    );
    const identity = screen.getByTestId("combined-left-panel");
    expect(identity).toHaveTextContent("Semantic test board");
    expect(identity).toHaveTextContent("Room 1234");
    expect(screen.getByRole("link", { name: "Back to Jazzboard home" })).toHaveAttribute("href", "/");

    const menuButton = screen.getByRole("button", { name: "Board menu" });
    fireEvent.click(menuButton);
    expect(await screen.findByRole("menuitem", { name: "Canvas outline · 2 selected" })).toHaveFocus();
    expect(screen.getByRole("menuitem", { name: "Preparing Ask…" })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Review · 3 pending" })).toBeEnabled();
    expect(screen.getByRole("menuitem", { name: /Undo/ })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await flushMicrotasks();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(menuButton).toHaveFocus();
  });

  it("selects a first-class visual group by semantic member IDs", () => {
    const { onSelectionChange } = renderCanvas();

    fireEvent.pointerDown(screen.getByRole("button", { name: /service: Room API/i }), { button: 0 });

    expect(onSelectionChange).toHaveBeenLastCalledWith(["node-a", "node-b"]);
    expect(screen.getByText("2 canvas objects selected.")).toBeInTheDocument();
  });

  it("pans from empty scene-group space without treating objects or chrome as the background", async () => {
    let runtime: CanvasRuntime | null = null;
    renderCanvas(vi.fn((next) => { runtime = next; }));
    await waitFor(() => expect(runtime).not.toBeNull());

    const canvas = screen.getByTestId("semantic-canvas");
    Object.defineProperties(canvas, {
      setPointerCapture: { configurable: true, value: vi.fn() },
      hasPointerCapture: { configurable: true, value: vi.fn(() => true) },
      releasePointerCapture: { configurable: true, value: vi.fn() },
    });
    const sceneGroup = canvas.querySelector("svg > g");
    expect(sceneGroup).not.toBeNull();
    const before = runtime!.getViewport();

    fireEvent.pointerDown(sceneGroup!, { button: 0, pointerId: 7, clientX: 400, clientY: 300 });
    fireEvent.pointerMove(canvas, { pointerId: 7, clientX: 460, clientY: 335 });
    fireEvent.pointerUp(canvas, { pointerId: 7, clientX: 460, clientY: 335 });

    expect(runtime!.getViewport()).toMatchObject({
      x: expect.any(Number),
      y: expect.any(Number),
    });
    expect(runtime!.getViewport().x).toBeLessThan(before.x);
    expect(runtime!.getViewport().y).toBeLessThan(before.y);
  });

  it("coalesces pointer presence, emits durable keyframes, and clears the cursor on leave", async () => {
    vi.useFakeTimers();
    const { presence, transientPresence } = renderCanvas();
    const canvas = screen.getByTestId("semantic-canvas");
    expect(presence).toHaveBeenCalledOnce();

    fireEvent.pointerMove(canvas, { pointerId: 70, clientX: 300, clientY: 220 });
    fireEvent.pointerMove(canvas, { pointerId: 70, clientX: 360, clientY: 260 });
    expect(transientPresence).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(TRANSIENT_PRESENCE_INTERVAL_MS); });
    expect(transientPresence).toHaveBeenCalledOnce();
    expect(transientPresence).toHaveBeenLastCalledWith(expect.objectContaining({
      cursor: expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }),
    }));

    await flushMicrotasks();
    await act(async () => { vi.advanceTimersByTime(ACTIVE_PRESENCE_KEYFRAME_MS); });
    await flushMicrotasks();
    expect(presence.mock.calls.length).toBeGreaterThanOrEqual(2);

    fireEvent.pointerLeave(canvas);
    await act(async () => { vi.advanceTimersByTime(TRANSIENT_PRESENCE_INTERVAL_MS); });
    expect(transientPresence).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: null }));
  });

  it("publishes one forced durable keyframe for every non-live to live reconnect edge", async () => {
    const presence = vi.fn().mockResolvedValue(undefined);
    const props = {
      boardMenuActions: menuActions,
      room,
      self,
      followTarget: null,
      presence,
      transientPresence: vi.fn(() => true),
      onSelectionChange: vi.fn(),
      onRuntimeChange: vi.fn(),
      onExitFollow: vi.fn(),
    } as const;
    const rendered = render(<SemanticCanvas {...props} connection="polling" />);
    expect(presence).not.toHaveBeenCalled();

    rendered.rerender(<SemanticCanvas {...props} connection="live" />);
    await flushMicrotasks();
    expect(presence).toHaveBeenCalledOnce();
    rendered.rerender(<SemanticCanvas {...props} connection="live" />);
    await flushMicrotasks();
    expect(presence).toHaveBeenCalledOnce();

    rendered.rerender(<SemanticCanvas {...props} connection="offline" />);
    rendered.rerender(<SemanticCanvas {...props} connection="live" />);
    await flushMicrotasks();
    expect(presence).toHaveBeenCalledTimes(2);
  });

  it("exposes the existing board actions through renderer-neutral chrome", () => {
    renderCanvas();

    fireEvent.click(screen.getByRole("button", { name: "Board menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Canvas outline" }));

    expect(menuActions.onCanvasOutline).toHaveBeenCalledOnce();
  });

  it("offers role upgrade only to spectators", () => {
    renderCanvas();
    fireEvent.click(screen.getByRole("button", { name: "Board menu" }));
    expect(screen.getByRole("menuitem", { name: "Become a participant" })).toBeVisible();
    expect(screen.queryByRole("menuitem", { name: /Ask agent/i })).toBeNull();
    cleanup();

    renderCanvas(vi.fn(), { ...self, role: "participant" });
    fireEvent.click(screen.getByRole("button", { name: "Board menu" }));
    expect(screen.queryByRole("menuitem", { name: "Become a participant" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Ask agent" })).toBeVisible();
  });

  it("exposes authoring tools only to an authorized participant", () => {
    renderCanvas();
    expect(screen.queryByRole("toolbar", { name: "Canvas tools" })).toBeNull();
    cleanup();

    const harness = makeEditingHarness(room);
    renderEditableCanvas(room, harness.editing);
    expect(screen.getByRole("toolbar", { name: "Canvas tools" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Select tool" })).toHaveAttribute("aria-pressed", "true");
  });

  it("routes select-all, native clipboard fallback, nudge, and Escape through the room-scoped semantic keyboard engine", async () => {
    const harness = makeEditingHarness(room);
    const rendered = renderEditableCanvas(room, harness.editing);
    const canvas = screen.getByTestId("semantic-canvas");

    fireEvent.keyDown(canvas, { key: "a", metaKey: true });
    expect(rendered.onSelectionChange).toHaveBeenLastCalledWith(["node-a", "node-b"]);
    const values = new Map<string, string>();
    const clipboardData = {
      files: [] as File[],
      types: [] as string[],
      setData: (type: string, value: string) => { values.set(type, value); },
      getData: (type: string) => values.get(type) ?? "",
    };
    expect(fireEvent.copy(canvas, { clipboardData })).toBe(false);
    values.set("text/plain", "An unrelated note copied after Jazzboard");
    expect(fireEvent.paste(canvas, { clipboardData })).toBe(true);
    expect(document.querySelectorAll("[data-object-id]")).toHaveLength(2);
    values.set("text/plain", "2 Jazzboard canvas objects");
    // Simulate a browser that removed the custom type while retaining the
    // mounted board's private in-memory fallback.
    expect(fireEvent.paste(canvas, { clipboardData })).toBe(false);
    expect(document.querySelectorAll("[data-object-id]")).toHaveLength(4);
    expect(rendered.onSelectionChange).toHaveBeenLastCalledWith([
      expect.stringMatching(/^object_/),
      expect.stringMatching(/^object_/),
    ]);

    const pastedId = rendered.onSelectionChange.mock.calls.at(-1)?.[0][0];
    const pasted = document.querySelector(`[data-object-id="${pastedId}"]`);
    const before = Number(pasted?.getAttribute("data-object-x"));
    fireEvent.keyDown(canvas, { key: "ArrowRight" });
    expect(Number(document.querySelector(`[data-object-id="${pastedId}"]`)?.getAttribute("data-object-x"))).toBe(before + 1);

    fireEvent.keyDown(canvas, { key: "Escape" });
    expect(rendered.onSelectionChange).toHaveBeenLastCalledWith([]);
  });

  it("absorbs a pending keyboard nudge into an overlapping pointer move", async () => {
    vi.useFakeTimers();
    const ungrouped = structuredClone(room);
    ungrouped.objects["node-a"]!.groupId = null;
    ungrouped.objects["node-b"]!.groupId = null;
    const harness = makeEditingHarness(ungrouped);
    renderEditableCanvas(ungrouped, harness.editing);
    const canvas = screen.getByTestId("semantic-canvas");
    const pointerCapture = installPointerCapture(canvas);
    const node = screen.getByRole("button", { name: /service: Room API/i });

    fireEvent.keyDown(node, { key: "Enter" });
    fireEvent.keyDown(node, { key: "ArrowRight" });
    expect(node).toHaveAttribute("data-object-x", "101");

    fireEvent.pointerDown(node, { button: 0, pointerId: 93, clientX: 240, clientY: 150 });
    expect(pointerCapture.setPointerCapture).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(300); });
    await flushMicrotasks();
    expect(harness.command).not.toHaveBeenCalled();

    fireEvent.pointerMove(canvas, { pointerId: 93, clientX: 320, clientY: 150 });
    expect(pointerCapture.setPointerCapture).toHaveBeenCalledOnce();
    expect(pointerCapture.setPointerCapture).toHaveBeenCalledWith(93);
    const finalX = Number(node.getAttribute("data-object-x"));
    expect(finalX).toBeGreaterThan(101);
    fireEvent.pointerUp(canvas, { pointerId: 93, clientX: 320, clientY: 150 });
    expect(pointerCapture.releasePointerCapture).toHaveBeenCalledWith(93);
    await act(async () => { vi.advanceTimersByTime(221); });
    await flushMicrotasks(32);

    expect(harness.command).toHaveBeenCalledOnce();
    expect(harness.command).toHaveBeenCalledWith(expect.objectContaining({
      type: "move",
      targets: [expect.objectContaining({ objectId: "node-a", x: finalX })],
    }), "human");
    expect(harness.getServerRoom().objects["node-a"]).toMatchObject({ x: finalX, revision: 2 });
  });

  it("uses the custom Jazzboard clipboard MIME for native copy and paste without exposing raw payload as plain text", () => {
    const harness = makeEditingHarness(room);
    const rendered = renderEditableCanvas(room, harness.editing);
    const canvas = screen.getByTestId("semantic-canvas");
    fireEvent.keyDown(canvas, { key: "a", metaKey: true });
    const values = new Map<string, string>();
    const clipboardData = {
      files: [] as File[],
      types: [] as string[],
      setData: (type: string, value: string) => { values.set(type, value); },
      getData: (type: string) => values.get(type) ?? "",
    };
    expect(fireEvent.copy(canvas, { clipboardData })).toBe(false);
    expect(values.get(SEMANTIC_CANVAS_CLIPBOARD_FORMAT)).toContain(SEMANTIC_CANVAS_CLIPBOARD_FORMAT);
    expect(values.get("text/plain")).toBe("2 Jazzboard canvas objects");
    expect(values.get("text/plain")).not.toContain("node-a");

    fireEvent.keyDown(canvas, { key: "Escape" });
    clipboardData.types = [SEMANTIC_CANVAS_CLIPBOARD_FORMAT];
    expect(fireEvent.paste(canvas, { clipboardData })).toBe(false);
    expect(document.querySelectorAll("[data-object-id]")).toHaveLength(4);
    expect(rendered.onSelectionChange).toHaveBeenLastCalledWith([
      expect.stringMatching(/^object_/), expect.stringMatching(/^object_/),
    ]);
  });

  it("owns acknowledged undo and redo, projects replay pixels immediately, and preserves history across conflict", async () => {
    vi.useFakeTimers();
    const historyRoom = structuredClone(room);
    historyRoom.objects["node-a"]!.groupId = null;
    historyRoom.objects["node-b"]!.groupId = null;
    const harness = makeEditingHarness(historyRoom);
    const defaultCommand = harness.editing.command;
    let commandImpl: SemanticCanvasEditingHost["command"] = defaultCommand;
    const routedCommand = vi.fn<SemanticCanvasEditingHost["command"]>((...args) => commandImpl(...args));
    const editing = { ...harness.editing, command: routedCommand };
    renderEditableCanvas(historyRoom, editing);
    const canvas = screen.getByTestId("semantic-canvas");
    installPointerCapture(canvas);
    const node = screen.getByRole("button", { name: /service: Room API/i });
    fireEvent.pointerDown(node, { button: 0, pointerId: 86, clientX: 240, clientY: 150 });
    fireEvent.pointerUp(canvas, { pointerId: 86, clientX: 240, clientY: 150 });

    fireEvent.keyDown(canvas, { key: "ArrowRight" });
    expect(node).toHaveAttribute("data-object-x", "101");
    await act(async () => { vi.advanceTimersByTime(221); });
    await flushMicrotasks(24);
    expect(harness.getServerRoom().objects["node-a"]!.x).toBe(101);

    fireEvent.pointerDown(node, { button: 0, pointerId: 88, clientX: 240, clientY: 150 });
    expect(fireEvent.keyDown(canvas, { key: "z", metaKey: true })).toBe(true);
    fireEvent.pointerCancel(canvas, { pointerId: 88, clientX: 240, clientY: 150 });
    await act(async () => { vi.advanceTimersByTime(221); });
    await flushMicrotasks();

    const conflict = Object.assign(new Error("Undo conflict"), { code: "REVISION_CONFLICT" });
    commandImpl = vi.fn(async () => { throw conflict; });
    expect(fireEvent.keyDown(canvas, { key: "z", metaKey: true })).toBe(false);
    expect(node).toHaveAttribute("data-object-x", "100");
    await act(async () => { vi.advanceTimersByTime(221); });
    await flushMicrotasks(32);
    expect(node).toHaveAttribute("data-object-x", "101");
    expect(harness.onError).toHaveBeenCalledWith("Undo conflict", conflict);

    const undoGate = deferred<{ room: RoomState; changedObjectIds: string[] }>();
    let undoCommand: CanvasCommand | null = null;
    commandImpl = vi.fn(async (command) => { undoCommand = command; return undoGate.promise; });
    expect(fireEvent.keyDown(canvas, { key: "z", metaKey: true })).toBe(false);
    expect(node).toHaveAttribute("data-object-x", "100");
    // The undo entry stays on its stack until the authoritative replay ack,
    // and redo is not yet a Jazzboard-owned browser action.
    expect(fireEvent.keyDown(canvas, { key: "z", metaKey: true, shiftKey: true })).toBe(true);
    await act(async () => { vi.advanceTimersByTime(221); });
    await flushMicrotasks();
    const undoAck = applyCommand(harness.getServerRoom(), undoCommand!);
    harness.setServerRoom(undoAck);
    await act(async () => { undoGate.resolve({ room: undoAck, changedObjectIds: ["node-a"] }); });
    await flushMicrotasks(32);

    const redoGate = deferred<{ room: RoomState; changedObjectIds: string[] }>();
    let redoCommand: CanvasCommand | null = null;
    commandImpl = vi.fn(async (command) => { redoCommand = command; return redoGate.promise; });
    expect(fireEvent.keyDown(canvas, { key: "z", metaKey: true, shiftKey: true })).toBe(false);
    expect(node).toHaveAttribute("data-object-x", "101");
    expect(fireEvent.keyDown(canvas, { key: "z", metaKey: true })).toBe(true);
    await act(async () => { vi.advanceTimersByTime(221); });
    await flushMicrotasks();
    const redoAck = applyCommand(harness.getServerRoom(), redoCommand!);
    harness.setServerRoom(redoAck);
    await act(async () => { redoGate.resolve({ room: redoAck, changedObjectIds: ["node-a"] }); });
    await flushMicrotasks(32);

    commandImpl = defaultCommand;
    expect(fireEvent.keyDown(canvas, { key: "z", metaKey: true })).toBe(false);
    await act(async () => { vi.advanceTimersByTime(221); });
    await flushMicrotasks(24);
    fireEvent.keyDown(canvas, { key: "ArrowDown" });
    await act(async () => { vi.advanceTimersByTime(221); });
    await flushMicrotasks(24);
    expect(node).toHaveAttribute("data-object-y", "101");
    // A newly acknowledged human edit clears the redo branch.
    expect(fireEvent.keyDown(canvas, { key: "z", metaKey: true, shiftKey: true })).toBe(true);
  });

  it("exposes acknowledged participant history in the Board menu and replays it optimistically", async () => {
    vi.useFakeTimers();
    const historyRoom = structuredClone(room);
    historyRoom.objects["node-a"]!.groupId = null;
    historyRoom.objects["node-b"]!.groupId = null;
    const harness = makeEditingHarness(historyRoom);
    renderEditableCanvas(historyRoom, harness.editing);
    const canvas = screen.getByTestId("semantic-canvas");
    installPointerCapture(canvas);
    const node = screen.getByRole("button", { name: /service: Room API/i });
    const menuButton = screen.getByRole("button", { name: "Board menu" });

    fireEvent.click(menuButton);
    expect(screen.getByRole("menuitem", { name: /Undo/ })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: /Redo/ })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await flushMicrotasks();

    fireEvent.pointerDown(node, { button: 0, pointerId: 87, clientX: 240, clientY: 150 });
    fireEvent.pointerUp(canvas, { pointerId: 87, clientX: 240, clientY: 150 });
    fireEvent.keyDown(node, { key: "ArrowRight" });
    expect(node).toHaveAttribute("data-object-x", "101");
    await act(async () => { vi.advanceTimersByTime(221); });
    await flushMicrotasks(24);

    fireEvent.click(menuButton);
    const undo = screen.getByRole("menuitem", { name: /Undo/ });
    expect(undo).toBeEnabled();
    fireEvent.click(undo);
    expect(node).toHaveAttribute("data-object-x", "100");
  });

  it("restores deleted Diagram membership through the host semantic transaction during undo", async () => {
    vi.useFakeTimers();
    const diagramRoom = structuredClone(room);
    diagramRoom.objects["node-a"]!.groupId = null;
    diagramRoom.objects["node-a"]!.diagramIds = ["diagram-1"];
    diagramRoom.objects["node-b"]!.groupId = null;
    diagramRoom.diagrams["diagram-1"] = {
      id: "diagram-1",
      title: "Room architecture",
      description: "The participant room request path.",
      diagramType: "architecture",
      category: "system",
      tags: ["room"],
      memberObjectIds: ["node-a"],
      connectorIds: [],
      bounds: { x: 100, y: 100, width: 180, height: 80 },
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
      createdBy: actor,
      lastEditedBy: actor,
    };
    const harness = makeEditingHarness(diagramRoom);
    const defaultCommand = harness.editing.command;
    let replayTransaction: SemanticTransaction | null = null;
    const editing: SemanticCanvasEditingHost = {
      ...harness.editing,
      command: vi.fn<SemanticCanvasEditingHost["command"]>(async (command, actorKind) => {
        if (command.type !== "delete") return defaultCommand(command, actorKind);
        const next = structuredClone(harness.getServerRoom());
        for (const target of command.targets) delete next.objects[target.objectId];
        const diagram = next.diagrams["diagram-1"]!;
        diagram.memberObjectIds = [];
        diagram.revision += 1;
        next.roomRevision += 1;
        next.stateRevision = (next.stateRevision ?? next.roomRevision) + 1;
        harness.setServerRoom(next);
        return { room: next, changedObjectIds: command.targets.map((target) => target.objectId) };
      }),
      semanticTransaction: vi.fn<SemanticCanvasEditingHost["semanticTransaction"]>(async (transaction) => {
        replayTransaction = transaction;
        let next = structuredClone(harness.getServerRoom());
        for (const command of transaction.commands) next = applyCommand(next, command);
        for (const command of transaction.diagramCommands) {
          if (command.type !== "diagram.update") continue;
          const current = next.diagrams[command.diagramId]!;
          next.diagrams[command.diagramId] = { ...current, ...command.patch, revision: current.revision + 1 };
        }
        const restored = next.objects["node-a"];
        if (restored && next.diagrams["diagram-1"]?.memberObjectIds.includes("node-a")) {
          restored.diagramIds = ["diagram-1"];
        }
        harness.setServerRoom(next);
        return {
          room: next,
          changedObjectIds: ["node-a"],
          changedDiagramIds: ["diagram-1"],
          membershipObjectIds: ["node-a"],
        };
      }),
    };
    renderEditableCanvas(diagramRoom, editing);
    const canvas = screen.getByTestId("semantic-canvas");
    installPointerCapture(canvas);
    const node = screen.getByRole("button", { name: /service: Room API/i });
    fireEvent.pointerDown(node, { button: 0, pointerId: 87, clientX: 240, clientY: 150 });
    fireEvent.pointerUp(canvas, { pointerId: 87, clientX: 240, clientY: 150 });
    fireEvent.keyDown(canvas, { key: "Delete" });
    await act(async () => { vi.advanceTimersByTime(221); });
    await flushMicrotasks(24);
    expect(document.querySelector('[data-object-id="node-a"]')).toBeNull();
    expect(harness.getServerRoom().diagrams["diagram-1"]!.memberObjectIds).toEqual([]);

    expect(fireEvent.keyDown(canvas, { key: "z", metaKey: true })).toBe(false);
    expect(document.querySelector('[data-object-id="node-a"]')).toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(221); });
    await flushMicrotasks(32);
    expect(replayTransaction).toMatchObject({
      commands: [{ type: "create", object: { id: "node-a" } }],
      diagramCommands: [{
        type: "diagram.update",
        diagramId: "diagram-1",
        patch: { memberObjectIds: ["node-a"] },
      }],
    });
    expect(harness.getServerRoom().objects["node-a"]!.diagramIds).toEqual(["diagram-1"]);
    expect(harness.getServerRoom().diagrams["diagram-1"]!.memberObjectIds).toEqual(["node-a"]);
  });

  it("starts a rotated resize from the exact semantic frame without a first-frame jump", () => {
    const rotatedRoom = structuredClone(room);
    const node = rotatedRoom.objects["node-a"];
    if (!node || node.kind !== "shape") throw new Error("Expected shape fixture.");
    node.groupId = null;
    node.rotation = Math.PI / 6;
    rotatedRoom.objects["node-b"]!.groupId = null;
    const harness = makeEditingHarness(rotatedRoom);
    const rendered = renderEditableCanvas(rotatedRoom, harness.editing);
    const runtime = rendered.getRuntime()!;
    const canvas = screen.getByTestId("semantic-canvas");
    installPointerCapture(canvas);
    fireEvent.pointerDown(screen.getByRole("button", { name: /service: Room API/i }), {
      button: 0, pointerId: 81, ...clientPointForPage(runtime, node.x + node.width / 2, node.y + node.height / 2),
    });
    fireEvent.pointerUp(canvas, { pointerId: 81, ...clientPointForPage(runtime, node.x + node.width / 2, node.y + node.height / 2) });

    const handle = screen.getByRole("button", { name: "Resize selection from south-east" });
    const cosine = Math.cos(node.rotation);
    const sine = Math.sin(node.rotation);
    const center = { x: node.x + node.width / 2, y: node.y + node.height / 2 };
    const corner = {
      x: center.x + node.width / 2 * cosine - node.height / 2 * sine,
      y: center.y + node.width / 2 * sine + node.height / 2 * cosine,
    };
    const start = clientPointForPage(runtime, corner.x, corner.y);
    fireEvent.pointerDown(handle, { button: 0, pointerId: 82, ...start });
    expect(screen.getByRole("button", { name: /service: Room API/i })).toHaveAttribute("data-object-width", String(node.width));
    expect(screen.getByRole("button", { name: /service: Room API/i })).toHaveAttribute("data-object-height", String(node.height));

    const localDelta = { x: 40, y: 20 };
    const end = clientPointForPage(runtime,
      corner.x + localDelta.x * cosine - localDelta.y * sine,
      corner.y + localDelta.x * sine + localDelta.y * cosine,
    );
    fireEvent.pointerMove(canvas, { pointerId: 82, ...end });
    expect(Number(screen.getByRole("button", { name: /service: Room API/i }).getAttribute("data-object-width"))).toBeCloseTo(node.width + 40, 6);
    expect(Number(screen.getByRole("button", { name: /service: Room API/i }).getAttribute("data-object-height"))).toBeCloseTo(node.height + 20, 6);
    fireEvent.pointerUp(canvas, { pointerId: 82, ...end });
  });

  it("applies contextual shape styles through one ordered semantic lifecycle and preserves node metadata validity", async () => {
    vi.useFakeTimers();
    const styleRoom = structuredClone(room);
    styleRoom.objects["node-a"]!.groupId = null;
    styleRoom.objects["node-b"]!.groupId = null;
    const harness = makeEditingHarness(styleRoom);
    renderEditableCanvas(styleRoom, harness.editing);
    const canvas = screen.getByTestId("semantic-canvas");
    installPointerCapture(canvas);
    const node = screen.getByRole("button", { name: /service: Room API/i });
    fireEvent.pointerDown(node, { button: 0, pointerId: 85, clientX: 250, clientY: 160 });
    fireEvent.pointerUp(canvas, { pointerId: 85, clientX: 250, clientY: 160 });

    fireEvent.change(screen.getByRole("combobox", { name: "Node type" }), {
      target: { value: "decision" },
    });
    expect(screen.getByRole("button", { name: /decision: Room API/i })).toHaveAttribute("data-node-type", "decision");
    await act(async () => { vi.advanceTimersByTime(221); });
    await flushMicrotasks(24);
    expect(harness.command).toHaveBeenCalledWith(expect.objectContaining({
      type: "update",
      objectId: "node-a",
      patch: expect.objectContaining({
        nodeType: "decision",
        nodeMetadata: expect.objectContaining({ kind: "decision", status: "proposed" }),
      }),
    }), "human");
  });

  it("edits a connector endpoint by semantic hit target and never binds it to another connector", async () => {
    vi.useFakeTimers();
    const connectorRoom = structuredClone(room);
    connectorRoom.objects["node-a"]!.groupId = null;
    connectorRoom.objects["node-b"]!.groupId = null;
    connectorRoom.objects["connector-1"] = {
      id: "connector-1", kind: "connector", x: 400, y: 140, width: 1, height: 1,
      rotation: 0, zIndex: 5, revision: 1, groupId: null, diagramIds: [],
      createdAt: 4, updatedAt: 4, createdBy: actor, lastEditedBy: actor,
      start: { x: 400, y: 140, objectId: "node-a", normalizedAnchor: { x: 1, y: 0.5 }, isPrecise: true, isExact: false, snap: "edge" },
      end: { x: 400, y: 140, objectId: "node-b", normalizedAnchor: { x: 0, y: 0.5 }, isPrecise: true, isExact: false, snap: "edge" },
      routing: { mode: "straight", kind: "straight", bend: 0, elbowMidPoint: 0.5, labelPosition: 0.5 },
      direction: "end", label: "Request", color: "black",
    };
    let submitted: CanvasCommand | null = null;
    const harness = makeEditingHarness(connectorRoom, async (command) => {
      submitted = command;
      const acknowledged = applyCommand(connectorRoom, command);
      return { room: acknowledged, changedObjectIds: ["connector-1"] };
    });
    const rendered = renderEditableCanvas(connectorRoom, harness.editing);
    const runtime = rendered.getRuntime()!;
    const canvas = screen.getByTestId("semantic-canvas");
    installPointerCapture(canvas);
    const connector = screen.getByRole("button", { name: /Connector: Request/i });
    const connectorPoint = clientPointForPage(runtime, 350, 140);
    fireEvent.pointerDown(connector, { button: 0, pointerId: 83, ...connectorPoint });
    fireEvent.pointerUp(canvas, { pointerId: 83, ...connectorPoint });

    const startHandle = screen.getByRole("button", { name: "Move connector start endpoint" });
    const start = clientPointForPage(runtime, 300, 140);
    const end = clientPointForPage(runtime, 450, 140);
    fireEvent.pointerDown(startHandle, { button: 0, pointerId: 84, ...start });
    fireEvent.pointerMove(canvas, { pointerId: 84, ...end });
    fireEvent.pointerUp(canvas, { pointerId: 84, ...end });
    await act(async () => { vi.advanceTimersByTime(32); });
    await flushMicrotasks(24);
    expect(submitted).toMatchObject({
      type: "update",
      objectId: "connector-1",
      patch: { start: { objectId: "node-b" } },
    });
  });

  it("accepts supported pasted and dropped images into the reviewed picker and leaves unrelated paste untouched", async () => {
    class DecodedImage {
      naturalWidth = 640;
      naturalHeight = 360;
      decoding = "auto";
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    }
    vi.stubGlobal("Image", DecodedImage);
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:pasted");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const harness = makeEditingHarness(room);
    renderEditableCanvas(room, harness.editing);
    const canvas = screen.getByTestId("semantic-canvas");

    const unrelated = new File(["text"], "notes.txt", { type: "text/plain" });
    expect(fireEvent.paste(canvas, { clipboardData: { files: [unrelated] } })).toBe(true);
    const image = new File(["png"], "architecture.png", { type: "image/png" });
    expect(fireEvent.paste(canvas, { clipboardData: { files: [image] } })).toBe(false);
    expect(await screen.findByRole("textbox", { name: "Image description" })).toHaveValue("architecture");
    expect(createObjectURL).toHaveBeenCalledWith(image);
    expect(harness.command).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel image selection" }));
    const dropped = new File(["png"], "dropped-flow.png", { type: "image/png" });
    expect(fireEvent.drop(canvas, {
      clientX: 420,
      clientY: 280,
      dataTransfer: {
        files: [dropped],
        items: [{ kind: "file", type: "image/png" }],
        dropEffect: "none",
      },
    })).toBe(false);
    expect(await screen.findByRole("textbox", { name: "Image description" })).toHaveValue("dropped flow");
    expect(createObjectURL).toHaveBeenCalledWith(dropped);
  });

  it("creates a reverse-drag rectangle immediately and settles to the exact acknowledged object", async () => {
    vi.useFakeTimers();
    const commandGate = deferred<{ room: RoomState; changedObjectIds: string[] }>();
    let submitted: CanvasCommand | null = null;
    const harness = makeEditingHarness(room, async (command) => {
      submitted = command;
      return commandGate.promise;
    });
    const rendered = renderEditableCanvas(room, harness.editing);
    expect(rendered.getRuntime()).not.toBeNull();
    const runtime = rendered.getRuntime()!;
    const canvas = screen.getByTestId("semantic-canvas");
    const background = canvas.querySelector("svg > g")!;
    installPointerCapture(canvas);
    fireEvent.click(screen.getByRole("button", { name: "Rectangle tool" }));
    const start = clientPointForPage(runtime, 620, 340);
    const end = clientPointForPage(runtime, 460, 230);

    fireEvent.pointerDown(background, { button: 0, pointerId: 51, ...start });
    fireEvent.pointerMove(canvas, { pointerId: 51, ...end });

    const optimistic = semanticObject("shape", "node-a");
    const objectId = optimistic.dataset.objectId!;
    expect(Number(optimistic.dataset.objectX)).toBeCloseTo(460, 8);
    expect(Number(optimistic.dataset.objectY)).toBeCloseTo(230, 8);
    expect(Number(optimistic.dataset.objectWidth)).toBeCloseTo(160, 8);
    expect(Number(optimistic.dataset.objectHeight)).toBeCloseTo(110, 8);
    expect(optimistic).toHaveAttribute("data-object-revision", "0");

    fireEvent.pointerUp(canvas, { pointerId: 51, ...end });
    await act(async () => { vi.advanceTimersByTime(32); });
    await flushMicrotasks();
    expect(submitted).toMatchObject({
      type: "create",
      object: {
        id: objectId,
        kind: "shape",
        x: expect.closeTo(460, 8),
        y: expect.closeTo(230, 8),
        width: expect.closeTo(160, 8),
        height: expect.closeTo(110, 8),
      },
    });

    const acknowledged = applyCommand(room, submitted!);
    harness.setServerRoom(acknowledged);
    await act(async () => { commandGate.resolve({ room: acknowledged, changedObjectIds: [objectId] }); });
    await flushMicrotasks(24);
    expect(document.querySelector(`[data-object-id="${objectId}"]`)).toHaveAttribute("data-object-revision", "1");
    expect(Number(document.querySelector(`[data-object-id="${objectId}"]`)?.getAttribute("data-object-x"))).toBeCloseTo(460, 8);
  });

  it("keeps an unresolved freehand create visible through newer room props for more than two seconds", async () => {
    vi.useFakeTimers();
    const commandGate = deferred<{ room: RoomState; changedObjectIds: string[] }>();
    const harness = makeEditingHarness(room, async () => commandGate.promise);
    const rendered = renderEditableCanvas(room, harness.editing);
    expect(rendered.getRuntime()).not.toBeNull();
    const runtime = rendered.getRuntime()!;
    const canvas = screen.getByTestId("semantic-canvas");
    const background = canvas.querySelector("svg > g")!;
    installPointerCapture(canvas);
    fireEvent.click(screen.getByRole("button", { name: "Draw tool" }));
    const start = clientPointForPage(runtime, 520, 360);
    const middle = clientPointForPage(runtime, 570, 390);
    const end = clientPointForPage(runtime, 640, 420);

    fireEvent.pointerDown(background, { button: 0, pointerId: 52, ...start });
    fireEvent.pointerMove(canvas, { pointerId: 52, ...middle });
    fireEvent.pointerMove(canvas, { pointerId: 52, ...end });
    fireEvent.pointerUp(canvas, { pointerId: 52, ...end });
    await act(async () => { vi.advanceTimersByTime(32); });
    await flushMicrotasks();
    const optimistic = semanticObject("draw");
    const objectId = optimistic.dataset.objectId!;
    const optimisticWidth = optimistic.dataset.objectWidth;
    expect(harness.command).toHaveBeenCalledOnce();

    const newerStaleRoom = structuredClone(room);
    newerStaleRoom.roomRevision = 8;
    newerStaleRoom.stateRevision = 9;
    newerStaleRoom.updatedAt = 9;
    rendered.rerenderRoom(newerStaleRoom);
    await act(async () => { vi.advanceTimersByTime(2_100); });
    await flushMicrotasks();

    expect(document.querySelector(`[data-object-id="${objectId}"]`)).toHaveAttribute("data-object-revision", "0");
    expect(document.querySelector(`[data-object-id="${objectId}"]`)).toHaveAttribute("data-object-width", optimisticWidth);
  });

  it("creates an object-bound elbow connector and preserves its semantic route through acknowledgement", async () => {
    vi.useFakeTimers();
    const commandGate = deferred<{ room: RoomState; changedObjectIds: string[] }>();
    let submitted: CanvasCommand | null = null;
    const harness = makeEditingHarness(room, async (command) => {
      submitted = command;
      return commandGate.promise;
    });
    const rendered = renderEditableCanvas(room, harness.editing);
    expect(rendered.getRuntime()).not.toBeNull();
    const runtime = rendered.getRuntime()!;
    const canvas = screen.getByTestId("semantic-canvas");
    installPointerCapture(canvas);
    fireEvent.click(screen.getByRole("button", { name: "Connector tool" }));
    fireEvent.click(screen.getByRole("button", { name: "Connector options" }));
    fireEvent.click(screen.getByRole("button", { name: "Elbow connector routing" }));
    const start = clientPointForPage(runtime, 190, 140);
    const end = clientPointForPage(runtime, 410, 140);

    fireEvent.pointerDown(screen.getByRole("button", { name: /service: Room API/i }), {
      button: 0,
      pointerId: 53,
      ...start,
    });
    fireEvent.pointerMove(canvas, { pointerId: 53, ...end });
    fireEvent.pointerUp(canvas, { pointerId: 53, ...end });
    await act(async () => { vi.advanceTimersByTime(32); });
    await flushMicrotasks();

    expect(submitted).toMatchObject({
      type: "create",
      object: {
        kind: "connector",
        start: { objectId: "node-a", snap: "edge" },
        end: { objectId: "node-b", snap: "edge" },
        routing: { mode: "elbow", kind: "elbow" },
        direction: "end",
      },
    });
    const connectorCreate = requireCreateCommand(submitted);
    const objectId = connectorCreate.object.id;
    const acknowledged = applyCommand(room, connectorCreate);
    harness.setServerRoom(acknowledged);
    await act(async () => { commandGate.resolve({ room: acknowledged, changedObjectIds: [objectId] }); });
    await flushMicrotasks(24);
    expect(document.querySelector(`[data-object-id="${objectId}"]`)).toHaveAttribute("data-object-revision", "1");
    expect(screen.getByRole("button", { name: "Select tool" })).toHaveAttribute("aria-pressed", "true");
  });

  it("marquee-selects semantic groups atomically in select mode", async () => {
    const harness = makeEditingHarness(room);
    const rendered = renderEditableCanvas(room, harness.editing);
    expect(rendered.getRuntime()).not.toBeNull();
    const runtime = rendered.getRuntime()!;
    const canvas = screen.getByTestId("semantic-canvas");
    const background = canvas.querySelector("svg > g")!;
    installPointerCapture(canvas);
    const start = clientPointForPage(runtime, 80, 80);
    const end = clientPointForPage(runtime, 510, 200);

    fireEvent.pointerDown(background, { button: 0, pointerId: 54, ...start });
    fireEvent.pointerMove(canvas, { pointerId: 54, ...end });
    expect(screen.getByTestId("semantic-marquee")).toBeInTheDocument();
    fireEvent.pointerUp(canvas, { pointerId: 54, ...end });

    expect(screen.getByRole("button", { name: /service: Room API/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Text: Authorized guest/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("2 canvas objects selected.")).toBeInTheDocument();
    expect(harness.command).not.toHaveBeenCalled();
  });

  it("uses the hand tool to pan without starting a marquee or mutation", async () => {
    const harness = makeEditingHarness(room);
    const rendered = renderEditableCanvas(room, harness.editing);
    expect(rendered.getRuntime()).not.toBeNull();
    const runtime = rendered.getRuntime()!;
    const canvas = screen.getByTestId("semantic-canvas");
    const background = canvas.querySelector("svg > g")!;
    installPointerCapture(canvas);
    fireEvent.click(screen.getByRole("button", { name: "Hand tool" }));
    const before = runtime.getViewport();

    fireEvent.pointerDown(background, { button: 0, pointerId: 55, clientX: 400, clientY: 300 });
    fireEvent.pointerMove(canvas, { pointerId: 55, clientX: 470, clientY: 350 });
    fireEvent.pointerUp(canvas, { pointerId: 55, clientX: 470, clientY: 350 });

    expect(runtime.getViewport().x).toBeLessThan(before.x);
    expect(runtime.getViewport().y).toBeLessThan(before.y);
    expect(screen.queryByTestId("semantic-marquee")).toBeNull();
    expect(harness.command).not.toHaveBeenCalled();
  });

  it("treats pointer cancellation as a successful final create boundary", async () => {
    vi.useFakeTimers();
    const harness = makeEditingHarness(room);
    const rendered = renderEditableCanvas(room, harness.editing);
    expect(rendered.getRuntime()).not.toBeNull();
    const runtime = rendered.getRuntime()!;
    const canvas = screen.getByTestId("semantic-canvas");
    const background = canvas.querySelector("svg > g")!;
    installPointerCapture(canvas);
    fireEvent.click(screen.getByRole("button", { name: "Ellipse tool" }));
    const start = clientPointForPage(runtime, 560, 260);
    const end = clientPointForPage(runtime, 680, 350);

    fireEvent.pointerDown(background, { button: 0, pointerId: 56, ...start });
    fireEvent.pointerMove(canvas, { pointerId: 56, ...end });
    fireEvent.pointerCancel(canvas, { pointerId: 56, ...end });
    await act(async () => { vi.advanceTimersByTime(32); });
    await flushMicrotasks(24);

    expect(harness.command).toHaveBeenCalledWith(expect.objectContaining({
      type: "create",
      object: expect.objectContaining({ kind: "shape", shape: "ellipse" }),
    }), "human");
    expect(semanticObject("shape", "node-a")).toHaveAttribute("data-object-revision", "1");
  });

  it("stops an active create engine and clears provisional pixels after rollback", async () => {
    vi.useFakeTimers();
    const failure = new Error("Rejected authoring create");
    const harness = makeEditingHarness(room, async () => { throw failure; });
    const rendered = renderEditableCanvas(room, harness.editing);
    expect(rendered.getRuntime()).not.toBeNull();
    const runtime = rendered.getRuntime()!;
    const canvas = screen.getByTestId("semantic-canvas");
    const background = canvas.querySelector("svg > g")!;
    installPointerCapture(canvas);
    fireEvent.click(screen.getByRole("button", { name: "Rectangle tool" }));
    const start = clientPointForPage(runtime, 560, 260);
    const end = clientPointForPage(runtime, 680, 350);

    fireEvent.pointerDown(background, { button: 0, pointerId: 57, ...start });
    fireEvent.pointerMove(canvas, { pointerId: 57, ...end });
    const optimisticId = semanticObject("shape", "node-a").dataset.objectId!;
    await act(async () => { vi.advanceTimersByTime(221); });
    await flushMicrotasks(32);

    expect(document.querySelector(`[data-object-id="${optimisticId}"]`)).toBeNull();
    expect(harness.onError).toHaveBeenCalledWith("Rejected authoring create", failure);
    expect(screen.getByRole("button", { name: "Select tool" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.pointerMove(canvas, { pointerId: 57, clientX: end.clientX + 50, clientY: end.clientY + 50 });
    fireEvent.pointerUp(canvas, { pointerId: 57, clientX: end.clientX + 50, clientY: end.clientY + 50 });
    await act(async () => { vi.advanceTimersByTime(500); });
    await flushMicrotasks();
    expect(harness.command).toHaveBeenCalledOnce();
  });

  it("opens text creation synchronously and sends exactly one final create after Enter", async () => {
    vi.useFakeTimers();
    const commandGate = deferred<{ room: RoomState; changedObjectIds: string[] }>();
    let submitted: CanvasCommand | null = null;
    const harness = makeEditingHarness(room, async (command) => {
      submitted = command;
      return commandGate.promise;
    });
    const rendered = renderEditableCanvas(room, harness.editing);
    expect(rendered.getRuntime()).not.toBeNull();
    const canvas = screen.getByTestId("semantic-canvas");
    const background = canvas.querySelector("svg > g")!;
    installPointerCapture(canvas);
    fireEvent.click(screen.getByRole("button", { name: "Text tool" }));
    const point = clientPointForPage(rendered.getRuntime()!, 600, 280);

    fireEvent.pointerDown(background, { button: 0, pointerId: 58, ...point });
    const editor = screen.getByRole("textbox", { name: /Edit text content for object text_/i });
    expect(editor).toHaveFocus();
    expect(editor).toHaveValue("");
    expect(screen.getByRole("button", { name: "Text: Empty text" })).toHaveAttribute("data-object-revision", "0");

    fireEvent.change(editor, { target: { value: "Authentication request flow" } });
    expect(editor).toHaveValue("Authentication request flow");
    const presenceOnly = structuredClone(room);
    presenceOnly.stateRevision = (presenceOnly.stateRevision ?? presenceOnly.roomRevision) + 1;
    presenceOnly.participants[self.participantId] = {
      ...self,
      role: "participant",
      lastSeenAt: 9_999,
    };
    rendered.rerenderRoom(presenceOnly, harness.editing);
    expect(screen.getByRole("textbox", { name: /Edit text content for object text_/i }))
      .toHaveValue("Authentication request flow");
    await act(async () => { vi.advanceTimersByTime(2_500); });
    await flushMicrotasks();
    expect(harness.command).not.toHaveBeenCalled();
    expect(submitted).toBeNull();

    fireEvent.keyDown(editor, { key: "Enter" });
    await act(async () => { vi.advanceTimersByTime(32); });
    await flushMicrotasks();
    expect(harness.command).toHaveBeenCalledOnce();
    expect(submitted).toMatchObject({
      type: "create",
      object: { kind: "text", content: "Authentication request flow" },
    });
    const textCreate = requireCreateCommand(submitted);
    const acknowledged = applyCommand(room, textCreate);
    harness.setServerRoom(acknowledged);
    await act(async () => { commandGate.resolve({ room: acknowledged, changedObjectIds: [textCreate.object.id] }); });
    await flushMicrotasks(32);

    expect(screen.queryByRole("textbox", { name: /Edit text content for object text_/i })).toBeNull();
    expect(screen.getByRole("button", { name: "Text: Authentication request flow" }))
      .toHaveAttribute("data-object-revision", "1");
  });

  it("lets Escape cancel an edited provisional text create with zero server mutation", async () => {
    vi.useFakeTimers();
    const harness = makeEditingHarness(room);
    const rendered = renderEditableCanvas(room, harness.editing);
    expect(rendered.getRuntime()).not.toBeNull();
    const canvas = screen.getByTestId("semantic-canvas");
    installPointerCapture(canvas);
    fireEvent.click(screen.getByRole("button", { name: "Text tool" }));
    const point = clientPointForPage(rendered.getRuntime()!, 600, 280);
    fireEvent.pointerDown(canvas.querySelector("svg > g")!, { button: 0, pointerId: 59, ...point });
    const editor = screen.getByRole("textbox", { name: /Edit text content for object text_/i });
    fireEvent.change(editor, { target: { value: "discard this draft" } });
    const objectId = editor.closest("[data-object-id]")?.getAttribute("data-object-id");
    fireEvent.keyDown(editor, { key: "Escape" });
    await act(async () => { vi.advanceTimersByTime(2_500); });
    await flushMicrotasks(32);

    expect(screen.queryByRole("textbox", { name: /Edit text content for object text_/i })).toBeNull();
    expect(objectId ? document.querySelector(`[data-object-id="${objectId}"]`) : null).toBeNull();
    expect(harness.command).not.toHaveBeenCalled();
  });

  it("commits a non-empty provisional text create on blur and cancels an empty one", async () => {
    vi.useFakeTimers();
    const harness = makeEditingHarness(room);
    const rendered = renderEditableCanvas(room, harness.editing);
    const canvas = screen.getByTestId("semantic-canvas");
    const background = canvas.querySelector("svg > g")!;
    installPointerCapture(canvas);
    const point = clientPointForPage(rendered.getRuntime()!, 600, 280);

    fireEvent.click(screen.getByRole("button", { name: "Text tool" }));
    fireEvent.pointerDown(background, { button: 0, pointerId: 59, ...point });
    fireEvent.blur(screen.getByRole("textbox", { name: /Edit text content for object text_/i }));
    await act(async () => { vi.advanceTimersByTime(500); });
    await flushMicrotasks(24);
    expect(harness.command).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Text tool" }));
    fireEvent.pointerDown(background, { button: 0, pointerId: 60, ...point });
    const editor = screen.getByRole("textbox", { name: /Edit text content for object text_/i });
    fireEvent.change(editor, { target: { value: "Committed on blur" } });
    fireEvent.blur(editor);
    await act(async () => { vi.advanceTimersByTime(32); });
    await flushMicrotasks(24);

    expect(harness.command).toHaveBeenCalledOnce();
    expect(harness.command).toHaveBeenCalledWith(expect.objectContaining({
      type: "create",
      object: expect.objectContaining({ kind: "text", content: "Committed on blur" }),
    }), "human");
  });

  it("rolls back a rejected final text create once without reviving the provisional editor", async () => {
    vi.useFakeTimers();
    const failure = new Error("Rejected final text create");
    const harness = makeEditingHarness(room, async () => { throw failure; });
    const rendered = renderEditableCanvas(room, harness.editing);
    const canvas = screen.getByTestId("semantic-canvas");
    installPointerCapture(canvas);
    fireEvent.click(screen.getByRole("button", { name: "Text tool" }));
    fireEvent.pointerDown(canvas.querySelector("svg > g")!, {
      button: 0,
      pointerId: 61,
      ...clientPointForPage(rendered.getRuntime()!, 600, 280),
    });
    const editor = screen.getByRole("textbox", { name: /Edit text content for object text_/i });
    fireEvent.change(editor, { target: { value: "Rejected but never placeholder" } });
    const objectId = editor.closest("[data-object-id]")?.getAttribute("data-object-id");
    fireEvent.keyDown(editor, { key: "Enter" });

    await act(async () => { vi.advanceTimersByTime(32); });
    await flushMicrotasks(32);

    expect(harness.command).toHaveBeenCalledOnce();
    expect(harness.command).toHaveBeenCalledWith(expect.objectContaining({
      type: "create",
      object: expect.objectContaining({ content: "Rejected but never placeholder" }),
    }), "human");
    expect(objectId ? document.querySelector(`[data-object-id="${objectId}"]`) : null).toBeNull();
    expect(screen.queryByRole("textbox", { name: /Edit text content for object text_/i })).toBeNull();
    expect(harness.onError).toHaveBeenCalledWith("Rejected final text create", failure);
  });

  it("disposes an unpublished text draft without commands or late promise effects", async () => {
    vi.useFakeTimers();
    const harness = makeEditingHarness(room);
    const rendered = renderEditableCanvas(room, harness.editing);
    const canvas = screen.getByTestId("semantic-canvas");
    installPointerCapture(canvas);
    fireEvent.click(screen.getByRole("button", { name: "Text tool" }));
    fireEvent.pointerDown(canvas.querySelector("svg > g")!, {
      button: 0,
      pointerId: 62,
      ...clientPointForPage(rendered.getRuntime()!, 600, 280),
    });
    fireEvent.change(screen.getByRole("textbox", { name: /Edit text content for object text_/i }), {
      target: { value: "Unmounted local draft" },
    });

    rendered.unmount();
    await act(async () => { vi.advanceTimersByTime(3_000); });
    await flushMicrotasks(24);

    expect(harness.command).not.toHaveBeenCalled();
    expect(harness.onError).not.toHaveBeenCalled();
  });

  it("deliberately permits shape authoring over an existing object without inferring layout policy", async () => {
    vi.useFakeTimers();
    const harness = makeEditingHarness(room);
    const rendered = renderEditableCanvas(room, harness.editing);
    expect(rendered.getRuntime()).not.toBeNull();
    const canvas = screen.getByTestId("semantic-canvas");
    installPointerCapture(canvas);
    fireEvent.click(screen.getByRole("button", { name: "Diamond tool" }));
    const point = clientPointForPage(rendered.getRuntime()!, 190, 140);

    fireEvent.pointerDown(screen.getByRole("button", { name: /service: Room API/i }), {
      button: 0,
      pointerId: 60,
      ...point,
    });
    fireEvent.pointerUp(canvas, { pointerId: 60, ...point });
    await act(async () => { vi.advanceTimersByTime(32); });
    await flushMicrotasks(24);

    expect(harness.command).toHaveBeenCalledWith(expect.objectContaining({
      type: "create",
      object: expect.objectContaining({ kind: "shape", shape: "diamond" }),
    }), "human");
  });

  it("keeps a grouped move frame-immediate across stale room props until authority acknowledges it", async () => {
    vi.useFakeTimers();
    const commandGate = deferred<{ room: RoomState; changedObjectIds: string[] }>();
    let submitted: CanvasCommand | null = null;
    const harness = makeEditingHarness(room);
    const latestCommand = vi.fn<SemanticCanvasEditingHost["command"]>(async (command) => {
      submitted = command;
      return commandGate.promise;
    });
    const { rerenderRoom } = renderEditableCanvas(room, harness.editing);
    const canvas = screen.getByTestId("semantic-canvas");
    installPointerCapture(canvas);
    const node = screen.getByRole("button", { name: /service: Room API/i });

    fireEvent.pointerDown(node, { button: 0, pointerId: 41, clientX: 260, clientY: 220 });
    fireEvent.pointerMove(canvas, { pointerId: 41, clientX: 380, clientY: 280 });

    const optimisticX = node.getAttribute("data-object-x");
    const optimisticY = node.getAttribute("data-object-y");
    expect(optimisticX).not.toBe("100");
    expect(optimisticY).not.toBe("100");
    expect(harness.command).not.toHaveBeenCalled();

    const staleHigherRoom = structuredClone(room);
    staleHigherRoom.roomRevision = 4;
    staleHigherRoom.stateRevision = 5;
    staleHigherRoom.updatedAt = 5;
    rerenderRoom(staleHigherRoom, { ...harness.editing, command: latestCommand });

    expect(screen.getByRole("button", { name: /service: Room API/i })).toHaveAttribute("data-object-x", optimisticX);
    expect(screen.getByRole("button", { name: /service: Room API/i })).toHaveAttribute("data-object-y", optimisticY);

    fireEvent.pointerUp(canvas, { pointerId: 41, clientX: 380, clientY: 280 });
    await act(async () => { vi.advanceTimersByTime(32); });
    await flushMicrotasks();
    expect(harness.command).not.toHaveBeenCalled();
    expect(latestCommand).toHaveBeenCalledOnce();
    expect(submitted).toMatchObject({ type: "move" });

    await act(async () => { vi.advanceTimersByTime(2_100); });
    await flushMicrotasks();
    expect(screen.getByRole("button", { name: /service: Room API/i })).toHaveAttribute("data-object-x", optimisticX);
    expect(screen.getByRole("button", { name: /service: Room API/i })).toHaveAttribute("data-object-y", optimisticY);

    const acknowledged = applyCommand(harness.getServerRoom(), submitted!);
    harness.setServerRoom(acknowledged);
    await act(async () => { commandGate.resolve({ room: acknowledged, changedObjectIds: ["node-a", "node-b"] }); });
    await flushMicrotasks();

    expect(screen.getByRole("button", { name: /service: Room API/i })).toHaveAttribute("data-object-x", optimisticX);
    expect(screen.getByRole("button", { name: /service: Room API/i })).toHaveAttribute("data-object-y", optimisticY);
    expect(screen.getByRole("button", { name: /service: Room API/i })).toHaveAttribute("data-object-revision", "2");
  });

  it("keeps a text draft visible across stale room props and settles to the acknowledged revision", async () => {
    vi.useFakeTimers();
    const commandGate = deferred<{ room: RoomState; changedObjectIds: string[] }>();
    let submitted: CanvasCommand | null = null;
    const harness = makeEditingHarness(room, async (command) => {
      submitted = command;
      return commandGate.promise;
    });
    const { rerenderRoom } = renderEditableCanvas(room, harness.editing);
    const textObject = screen.getByRole("button", { name: /Text: Authorized guest/i });

    fireEvent.doubleClick(textObject);
    await act(async () => { vi.advanceTimersByTime(17); });
    const editor = screen.getByRole("textbox", { name: /Edit text content for object node-b/i });
    fireEvent.change(editor, { target: { value: "Optimistic authorization" } });

    expect(editor).toHaveValue("Optimistic authorization");
    expect(screen.getByRole("button", { name: /Text: Optimistic authorization/i })).toBeInTheDocument();

    const staleHigherRoom = structuredClone(room);
    staleHigherRoom.roomRevision = 4;
    staleHigherRoom.stateRevision = 5;
    staleHigherRoom.updatedAt = 5;
    rerenderRoom(staleHigherRoom, { ...harness.editing });

    expect(screen.getByRole("textbox", { name: /Edit text content for object node-b/i })).toHaveValue("Optimistic authorization");
    expect(screen.getByRole("button", { name: /Text: Optimistic authorization/i })).toBeInTheDocument();

    fireEvent.keyDown(editor, { key: "Enter", ctrlKey: true });
    await act(async () => { vi.advanceTimersByTime(32); });
    await flushMicrotasks();
    expect(harness.command).toHaveBeenCalledOnce();
    expect(submitted).toMatchObject({ type: "update", objectId: "node-b" });

    const acknowledged = applyCommand(harness.getServerRoom(), submitted!);
    harness.setServerRoom(acknowledged);
    await act(async () => { commandGate.resolve({ room: acknowledged, changedObjectIds: ["node-b"] }); });
    await flushMicrotasks();

    expect(screen.queryByRole("textbox", { name: /Edit text content for object node-b/i })).toBeNull();
    expect(screen.getByRole("button", { name: /Text: Optimistic authorization/i })).toHaveAttribute("data-object-revision", "2");
  });

  it("transitions a double-click pointer lease from move to edit before text authoring", async () => {
    vi.useFakeTimers();
    const textRoom = structuredClone(room);
    textRoom.objects["node-a"]!.groupId = null;
    textRoom.objects["node-b"]!.groupId = null;
    const harness = makeEditingHarness(textRoom);
    const rendered = renderEditableCanvas(textRoom, harness.editing);
    const canvas = screen.getByTestId("semantic-canvas");
    const pointerCapture = installPointerCapture(canvas);
    const textHitSurface = () => screen.getByRole("button", { name: /Text: Authorized guest/i })
      .querySelector(".semantic-canvas-object__text-hit-surface")!;

    // Model the browser ordering produced by Playwright and Chrome: pointer-up
    // has finished the move before `dblclick` requests text editing.
    fireEvent.pointerDown(textHitSurface(), { button: 0, pointerId: 91, clientX: 360, clientY: 130 });
    await flushMicrotasks();
    expect(pointerCapture.setPointerCapture).not.toHaveBeenCalled();
    expect(harness.getServerRoom().leases["node-b"]).toMatchObject({ operation: "move" });
    rendered.rerenderRoom(harness.getServerRoom(), { ...harness.editing });
    fireEvent.pointerUp(canvas, { button: 0, pointerId: 91, clientX: 360, clientY: 130 });
    expect(pointerCapture.releasePointerCapture).not.toHaveBeenCalled();
    fireEvent.doubleClick(textHitSurface(), { button: 0, clientX: 360, clientY: 130 });

    await flushMicrotasks();
    expect(screen.getByRole("textbox", { name: /Edit text content for object node-b/i })).toBeVisible();
    expect(harness.getServerRoom().leases["node-b"]).toMatchObject({ operation: "edit" });
    expect(vi.mocked(harness.editing.lease).mock.calls.filter(([action]) =>
      action.action === "acquire" && action.objectId === "node-b",
    ).map(([action]) => action.action === "acquire" ? action.operation : null)).toContain("edit");

    await act(async () => { vi.advanceTimersByTime(17); });
    await flushMicrotasks();
    expect(screen.getByRole("textbox", { name: /Edit text content for object node-b/i })).toBeVisible();
    expect(harness.getServerRoom().leases["node-b"]).toMatchObject({ operation: "edit" });
  });

  it("transitions to edit when double-click arrives before an active pointer-up", async () => {
    vi.useFakeTimers();
    const textRoom = structuredClone(room);
    textRoom.objects["node-a"]!.groupId = null;
    textRoom.objects["node-b"]!.groupId = null;
    const harness = makeEditingHarness(textRoom);
    renderEditableCanvas(textRoom, harness.editing);
    const canvas = screen.getByTestId("semantic-canvas");
    installPointerCapture(canvas);
    const hitSurface = screen.getByRole("button", { name: /Text: Authorized guest/i })
      .querySelector(".semantic-canvas-object__text-hit-surface")!;

    fireEvent.pointerDown(hitSurface, { button: 0, pointerId: 94, clientX: 360, clientY: 130 });
    await flushMicrotasks();
    expect(harness.getServerRoom().leases["node-b"]).toMatchObject({ operation: "move" });
    fireEvent.doubleClick(hitSurface, { button: 0, clientX: 360, clientY: 130 });
    await flushMicrotasks();

    expect(screen.getByRole("textbox", { name: /Edit text content for object node-b/i })).toBeVisible();
    expect(harness.getServerRoom().leases["node-b"]).toMatchObject({ operation: "edit" });
  });

  it("keeps no-motion click cycles on the object so native double-click opens editing", async () => {
    vi.useFakeTimers();
    const textRoom = structuredClone(room);
    textRoom.objects["node-a"]!.groupId = null;
    textRoom.objects["node-b"]!.groupId = null;
    const harness = makeEditingHarness(textRoom);
    renderEditableCanvas(textRoom, harness.editing);
    const canvas = screen.getByTestId("semantic-canvas");
    const pointerCapture = installPointerCapture(canvas);
    const hitSurface = () => screen.getByRole("button", { name: /Text: Authorized guest/i })
      .querySelector(".semantic-canvas-object__text-hit-surface")!;

    for (let index = 0; index < 2; index += 1) {
      fireEvent.pointerDown(hitSurface(), { button: 0, pointerId: 95, clientX: 360, clientY: 130 });
      await flushMicrotasks();
      fireEvent.pointerUp(hitSurface(), { button: 0, pointerId: 95, clientX: 360, clientY: 130 });
      fireEvent.click(hitSurface(), { button: 0, clientX: 360, clientY: 130 });
    }
    expect(pointerCapture.setPointerCapture).not.toHaveBeenCalled();
    expect(pointerCapture.releasePointerCapture).not.toHaveBeenCalled();
    fireEvent.doubleClick(hitSurface(), { button: 0, clientX: 360, clientY: 130 });
    await flushMicrotasks();
    expect(screen.getByRole("textbox", { name: /Edit text content for object node-b/i })).toBeVisible();
    expect(harness.getServerRoom().leases["node-b"]).toMatchObject({ operation: "edit" });
    expect(vi.mocked(harness.editing.lease).mock.calls.filter(([action]) =>
      action.action === "acquire" && action.objectId === "node-b" && action.operation === "move",
    )).toHaveLength(1);
  });

  it("stops an active text editor and restores authority after a rejected save", async () => {
    vi.useFakeTimers();
    const failure = new Error("Canvas changed elsewhere");
    const harness = makeEditingHarness(room, async () => { throw failure; });
    renderEditableCanvas(room, harness.editing);

    fireEvent.doubleClick(screen.getByRole("button", { name: /Text: Authorized guest/i }));
    await act(async () => { vi.advanceTimersByTime(17); });
    const editor = screen.getByRole("textbox", { name: /Edit text content for object node-b/i });
    fireEvent.change(editor, { target: { value: "Rejected draft" } });
    expect(screen.getByRole("button", { name: /Text: Rejected draft/i })).toBeInTheDocument();

    await act(async () => { vi.advanceTimersByTime(221); });
    await flushMicrotasks(24);

    expect(screen.queryByRole("textbox", { name: /Edit text content for object node-b/i })).toBeNull();
    expect(screen.getByRole("button", { name: /Text: Authorized guest/i })).toHaveAttribute("data-object-revision", "1");
    expect(harness.onError).toHaveBeenCalledWith("Canvas changed elsewhere", failure);
  });

  it("routes Escape through cancellation recovery without committing the draft", async () => {
    vi.useFakeTimers();
    const harness = makeEditingHarness(room);
    renderEditableCanvas(room, harness.editing);

    fireEvent.doubleClick(screen.getByRole("button", { name: /Text: Authorized guest/i }));
    await act(async () => { vi.advanceTimersByTime(17); });
    const editor = screen.getByRole("textbox", { name: /Edit text content for object node-b/i });
    fireEvent.change(editor, { target: { value: "Discard this draft" } });
    fireEvent.keyDown(editor, { key: "Escape" });
    await flushMicrotasks(24);

    expect(screen.queryByRole("textbox", { name: /Edit text content for object node-b/i })).toBeNull();
    expect(screen.getByRole("button", { name: /Text: Authorized guest/i })).toHaveAttribute("data-object-revision", "1");
    expect(harness.command).not.toHaveBeenCalled();
    expect(harness.onError).not.toHaveBeenCalled();
  });

  it("acquires the complete grouped move lease cohort on pointer-down before movement", () => {
    const groupedRoom = structuredClone(room);
    groupedRoom.objects["edge-a-b"] = {
      id: "edge-a-b",
      kind: "connector",
      x: 280,
      y: 140,
      width: 40,
      height: 1,
      rotation: 0,
      zIndex: 3,
      revision: 1,
      groupId: "group-1",
      diagramIds: [],
      createdAt: 1,
      updatedAt: 2,
      createdBy: actor,
      lastEditedBy: actor,
      start: { x: 280, y: 140, objectId: "node-a" },
      end: { x: 320, y: 140, objectId: "node-b" },
      direction: "end",
      label: "calls",
      color: "black",
    };
    const harness = makeEditingHarness(groupedRoom);
    renderEditableCanvas(groupedRoom, harness.editing);
    const canvas = screen.getByTestId("semantic-canvas");
    installPointerCapture(canvas);
    const source = screen.getByRole("button", { name: /service: Room API/i });

    fireEvent.pointerDown(source, {
      button: 0,
      pointerId: 81,
      clientX: 180,
      clientY: 140,
    });

    expect(source).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Text: Authorized guest/i }))
      .toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /Connector: calls/i }))
      .toHaveAttribute("aria-pressed", "true");
    expect(harness.editing.leaseMany).toHaveBeenCalledOnce();
    expect(harness.editing.leaseMany).toHaveBeenCalledWith(
      {
        action: "acquire-many",
        targets: [
          { objectId: "edge-a-b", expectedRevision: 1, operation: "connect" },
          { objectId: "node-a", expectedRevision: 1, operation: "move" },
          { objectId: "node-b", expectedRevision: 1, operation: "move" },
        ],
      },
      "human",
    );
    expect(harness.command).not.toHaveBeenCalled();
  });

  it("keeps its edit controller live across development Strict Mode effect replay", async () => {
    const harness = makeEditingHarness(room);
    const participant = { ...self, role: "participant" as const };
    render(
      <StrictMode>
        <SemanticCanvas
          boardMenuActions={menuActions}
          room={room}
          self={participant}
          followTarget={null}
          presence={vi.fn().mockResolvedValue(undefined)}
          transientPresence={vi.fn(() => true)}
          connection="live"
          onSelectionChange={vi.fn()}
          onRuntimeChange={vi.fn()}
          onExitFollow={vi.fn()}
          editing={harness.editing}
        />
      </StrictMode>,
    );
    await flushMicrotasks();
    installPointerCapture(screen.getByTestId("semantic-canvas"));

    fireEvent.pointerDown(screen.getByRole("button", { name: /service: Room API/i }), {
      button: 0,
      pointerId: 84,
      clientX: 180,
      clientY: 140,
    });

    expect(harness.editing.leaseMany).toHaveBeenCalledOnce();
    expect(harness.editing.leaseMany).toHaveBeenCalledWith(
      {
        action: "acquire-many",
        targets: [
          { objectId: "node-a", expectedRevision: 1, operation: "move" },
          { objectId: "node-b", expectedRevision: 1, operation: "move" },
        ],
      },
      "human",
    );
  });

  it("refreshes object pointer handlers when a rendered board becomes editable", () => {
    const harness = makeEditingHarness(room);
    const participant = { ...self, role: "participant" as const };
    const props = {
      boardMenuActions: menuActions,
      room,
      self: participant,
      followTarget: null,
      presence: vi.fn().mockResolvedValue(undefined),
      transientPresence: vi.fn(() => true),
      connection: "live" as const,
      onSelectionChange: vi.fn(),
      onRuntimeChange: vi.fn(),
      onExitFollow: vi.fn(),
    };
    const rendered = render(<SemanticCanvas {...props} editing={null} />);
    const passiveNode = screen.getByRole("button", { name: /service: Room API/i });
    fireEvent.pointerDown(passiveNode, {
      button: 0,
      pointerId: 82,
      clientX: 180,
      clientY: 140,
    });
    expect(harness.editing.leaseMany).not.toHaveBeenCalled();

    rendered.rerender(<SemanticCanvas {...props} editing={harness.editing} />);
    const canvas = screen.getByTestId("semantic-canvas");
    installPointerCapture(canvas);
    expect(canvas).toHaveAttribute("data-canvas-editing", "enabled");
    fireEvent.pointerDown(screen.getByRole("button", { name: /service: Room API/i }), {
      button: 0,
      pointerId: 83,
      clientX: 180,
      clientY: 140,
    });

    expect(harness.editing.leaseMany).toHaveBeenCalledOnce();
    expect(harness.editing.leaseMany).toHaveBeenCalledWith(
      {
        action: "acquire-many",
        targets: [
          { objectId: "node-a", expectedRevision: 1, operation: "move" },
          { objectId: "node-b", expectedRevision: 1, operation: "move" },
        ],
      },
      "human",
    );
  });

  it("never exposes participant mutations to a spectator even if an editing host is supplied", async () => {
    vi.useFakeTimers();
    const harness = makeEditingHarness(room);
    renderEditableCanvas(room, harness.editing, self);
    const canvas = screen.getByTestId("semantic-canvas");
    installPointerCapture(canvas);
    const node = screen.getByRole("button", { name: /service: Room API/i });

    fireEvent.pointerDown(node, { button: 0, pointerId: 8, clientX: 200, clientY: 200 });
    fireEvent.pointerMove(canvas, { pointerId: 8, clientX: 340, clientY: 280 });
    fireEvent.pointerUp(canvas, { pointerId: 8, clientX: 340, clientY: 280 });
    fireEvent.doubleClick(node);
    await act(async () => { vi.advanceTimersByTime(500); });
    await flushMicrotasks();

    expect(canvas).toHaveAttribute("data-canvas-editing", "disabled");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(harness.command).not.toHaveBeenCalled();
    expect(harness.editing.lease).not.toHaveBeenCalled();
    expect(harness.editing.leaseMany).not.toHaveBeenCalled();
  });
});
