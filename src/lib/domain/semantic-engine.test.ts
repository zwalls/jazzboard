import { describe, expect, it } from "vitest";

import {
  BULK_CONNECTOR_ROUTING_THRESHOLD,
  applyLayoutCommand,
  applySemanticTransaction,
  normalizeRoomSemanticState,
} from "./engine";
import { DomainError } from "./errors";
import {
  connectorRouteBounds,
  normalizeConnectorRouting,
  resolveConnectorRoutes,
} from "./connector-routing";
import { connectorLabelBounds } from "./layout";
import type {
  ActorRef,
  CanvasObject,
  Diagram,
  Participant,
  RoomState,
} from "./types";

const NOW = 2_000_000;

function participant(participantId: string, displayName: string): Participant {
  const presence = { cursor: null, viewport: null, lastSeenAt: NOW, activity: null };
  return {
    participantId,
    displayName,
    color: participantId === "alice" ? "blue" : "red",
    role: "participant",
    joinedAt: NOW,
    lastSeenAt: NOW,
    connected: true,
    agentActive: false,
    human: { ...presence },
    agent: { ...presence },
  };
}

const alice = participant("alice", "Alice");
const bob = participant("bob", "Bob");

function actor(owner: Participant, kind: "human" | "agent" = "human"): ActorRef {
  return {
    participantId: owner.participantId,
    displayName: owner.displayName,
    color: owner.color,
    kind,
  };
}

function node(id: string, x: number, y: number, revision = 1): CanvasObject {
  return {
    id,
    kind: "shape",
    x,
    y,
    width: 200,
    height: 100,
    rotation: 0,
    zIndex: 1,
    revision,
    groupId: null,
    diagramIds: [],
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: actor(alice),
    lastEditedBy: actor(alice),
    shape: "rectangle",
    nodeType: "service",
    label: id,
    fill: "green",
    stroke: "green",
  };
}

function connector(id: string, startId: string, endId: string): CanvasObject {
  return {
    id,
    kind: "connector",
    x: 200,
    y: 50,
    width: 200,
    height: 1,
    rotation: 0,
    zIndex: 0,
    revision: 1,
    groupId: null,
    diagramIds: [],
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: actor(alice),
    lastEditedBy: actor(alice),
    start: { x: 200, y: 50, objectId: startId },
    end: { x: 400, y: 50, objectId: endId },
    direction: "end",
    label: `${startId} to ${endId}`,
    color: "black",
  };
}

function sizedNode(id: string, width: number, height: number): CanvasObject {
  return { ...node(id, 0, 0), width, height };
}

function unlabeledConnector(id: string, startId: string, endId: string): CanvasObject {
  const edge = connector(id, startId, endId);
  if (edge.kind !== "connector") throw new Error("Expected connector fixture.");
  return { ...edge, label: "" };
}

function crossingCount(
  edges: ReadonlyArray<readonly [string, string]>,
  secondaryPosition: ReadonlyMap<string, number>,
): number {
  let crossings = 0;
  for (let leftIndex = 0; leftIndex < edges.length; leftIndex += 1) {
    const [leftStart, leftEnd] = edges[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < edges.length; rightIndex += 1) {
      const [rightStart, rightEnd] = edges[rightIndex];
      if (leftStart === rightStart || leftEnd === rightEnd) continue;
      const startDelta =
        (secondaryPosition.get(leftStart) ?? 0) - (secondaryPosition.get(rightStart) ?? 0);
      const endDelta =
        (secondaryPosition.get(leftEnd) ?? 0) - (secondaryPosition.get(rightEnd) ?? 0);
      if (startDelta * endDelta < 0) crossings += 1;
    }
  }
  return crossings;
}

function diagram(memberObjectIds: string[], connectorIds: string[] = []): Diagram {
  return {
    id: "diagram-main",
    title: "Main architecture",
    description: "Authoritative diagram",
    diagramType: "architecture",
    category: "system",
    tags: ["demo"],
    memberObjectIds,
    connectorIds,
    bounds: { x: 0, y: 0, width: 1, height: 1 },
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    createdBy: actor(alice),
    lastEditedBy: actor(alice),
  };
}

function room(objects: CanvasObject[], diagrams: Diagram[] = []): RoomState {
  return normalizeRoomSemanticState({
    id: "room-semantic",
    code: "2468",
    title: "Semantic room",
    roomRevision: 4,
    createdAt: NOW,
    updatedAt: NOW,
    participants: { alice: structuredClone(alice), bob: structuredClone(bob) },
    objects: Object.fromEntries(objects.map((object) => [object.id, object])),
    diagrams: Object.fromEntries(diagrams.map((item) => [item.id, item])),
    leases: {},
    spotlight: null,
    agentEditPolicy: "live",
    reviewProposals: [],
  });
}

function persistAuthoritativeConnectorRoutes(source: RoomState): RoomState {
  const routes = resolveConnectorRoutes(source);
  for (const object of Object.values(source.objects)) {
    if (object.kind !== "connector") continue;
    const route = routes[object.id];
    if (!route) continue;
    Object.assign(object, {
      ...connectorRouteBounds(route.points, 0),
      rotation: 0,
      start: route.start,
      end: route.end,
      routing: route.routing,
    });
  }
  return normalizeRoomSemanticState(source);
}

function captureDomainError(run: () => unknown): DomainError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    return error as DomainError;
  }
  throw new Error("Expected DomainError");
}

describe("deterministic hierarchy layout", () => {
  it("uses barycentric rank ordering to remove crossings caused by target order", () => {
    const ids = ["source-a", "source-b", "target-b", "target-a"];
    const edges = [
      ["source-a", "target-a"],
      ["source-b", "target-b"],
    ] as const;
    const source = room([
      ...ids.map((id) => node(id, 0, 0)),
      ...edges.map(([start, end]) => unlabeledConnector(`${start}-${end}`, start, end)),
    ]);

    const result = applyLayoutCommand(source, "alice", "agent", {
      layout: "hierarchy",
      direction: "right",
      density: "comfortable",
      origin: { x: 0, y: 0 },
      targets: ids.map((objectId) => ({ objectId, expectedRevision: 1 })),
    });
    const before = new Map(ids.map((id, index) => [id, index]));
    const after = new Map(result.positions.map((position) => [position.objectId, position.y]));

    expect(crossingCount(edges, before)).toBe(1);
    expect(crossingCount(edges, after)).toBe(0);
    expect(after.get("target-a")).toBeLessThan(after.get("target-b")!);
  });

  it("optimizes a long edge against connectors on every intermediate rank boundary", () => {
    const ids = ["source-a", "source-b", "middle-c", "middle-d", "sink-e", "sink-f"];
    const source = room([
      ...ids.map((id) => node(id, 0, 0)),
      unlabeledConnector("long-a-f", "source-a", "sink-f"),
      unlabeledConnector("b-c", "source-b", "middle-c"),
      unlabeledConnector("b-d", "source-b", "middle-d"),
      unlabeledConnector("c-e", "middle-c", "sink-e"),
      unlabeledConnector("d-e", "middle-d", "sink-e"),
      unlabeledConnector("d-f", "middle-d", "sink-f"),
    ]);

    const result = applyLayoutCommand(source, "alice", "agent", {
      layout: "hierarchy",
      direction: "right",
      density: "comfortable",
      origin: { x: 0, y: 0 },
      targets: ids.map((objectId) => ({ objectId, expectedRevision: 1 })),
    });
    const secondary = new Map(result.positions.map((position) => [position.objectId, position.y]));

    // The long source-a→sink-f edge crosses source-b→middle-c in the input
    // order. Accounting for its intermediate rank segment moves source-b up.
    expect(secondary.get("source-b")).toBeLessThan(secondary.get("source-a")!);
    expect(secondary.get("middle-c")).toBeLessThan(secondary.get("middle-d")!);
    expect(secondary.get("sink-e")).toBeLessThan(secondary.get("sink-f")!);
  });

  it("centers hubs and retains optimized branch ordering across three ranks", () => {
    const ids = ["hub", "api-a", "api-b", "api-c", "store-c", "store-b", "store-a"];
    const edges = [
      ["hub", "api-a"],
      ["hub", "api-b"],
      ["hub", "api-c"],
      ["api-a", "store-a"],
      ["api-b", "store-b"],
      ["api-c", "store-c"],
    ] as const;
    const source = room([
      ...ids.map((id) => node(id, 0, 0)),
      ...edges.map(([start, end]) => unlabeledConnector(`${start}-${end}`, start, end)),
    ]);

    const result = applyLayoutCommand(source, "alice", "agent", {
      layout: "hierarchy",
      direction: "right",
      density: "comfortable",
      origin: { x: 50, y: 25 },
      targets: ids.map((objectId) => ({ objectId, expectedRevision: 1 })),
    });
    const positions = new Map(result.positions.map((position) => [position.objectId, position]));
    const secondary = new Map(result.positions.map((position) => [position.objectId, position.y]));

    expect(positions.get("hub")).toMatchObject({ x: 50, y: 225 });
    expect(secondary.get("store-a")).toBeLessThan(secondary.get("store-b")!);
    expect(secondary.get("store-b")).toBeLessThan(secondary.get("store-c")!);
    expect(crossingCount(edges.slice(3), secondary)).toBe(0);
  });

  it("packs disconnected components and isolated nodes into non-overlapping bands", () => {
    const ids = ["first-a", "first-b", "fork", "leaf-a", "leaf-b", "isolated"];
    const source = room([
      ...ids.map((id) => node(id, 0, 0)),
      unlabeledConnector("first-edge", "first-a", "first-b"),
      unlabeledConnector("fork-a", "fork", "leaf-a"),
      unlabeledConnector("fork-b", "fork", "leaf-b"),
    ]);

    const result = applyLayoutCommand(source, "alice", "agent", {
      layout: "hierarchy",
      direction: "right",
      density: "comfortable",
      origin: { x: 0, y: 0 },
      targets: ids.map((objectId) => ({ objectId, expectedRevision: 1 })),
    });
    const positions = new Map(result.positions.map((position) => [position.objectId, position]));

    expect(positions.get("first-a")).toMatchObject({ x: 0, y: 0 });
    expect(positions.get("fork")).toMatchObject({ x: 0, y: 300 });
    expect(positions.get("leaf-a")).toMatchObject({ x: 360, y: 200 });
    expect(positions.get("leaf-b")).toMatchObject({ x: 360, y: 400 });
    expect(positions.get("isolated")).toMatchObject({ x: 0, y: 600 });
  });

  it("uses actual node dimensions for rank gaps and centering", () => {
    const ids = ["short", "tall", "destination"];
    const source = room([
      sizedNode("short", 120, 60),
      sizedNode("tall", 240, 100),
      sizedNode("destination", 180, 160),
      unlabeledConnector("short-destination", "short", "destination"),
      unlabeledConnector("tall-destination", "tall", "destination"),
    ]);

    const result = applyLayoutCommand(source, "alice", "agent", {
      layout: "hierarchy",
      direction: "right",
      density: "compact",
      origin: { x: 10, y: 10 },
      targets: ids.map((objectId) => ({ objectId, expectedRevision: 1 })),
    });

    expect(result.positions).toEqual([
      { objectId: "short", x: 10, y: 10 },
      { objectId: "tall", x: 10, y: 118 },
      { objectId: "destination", x: 322, y: 34 },
    ]);
  });

  it("produces identical hierarchy positions for identical inputs", () => {
    const ids = ["root-b", "root-a", "middle-b", "middle-a", "sink"];
    const objects = [
      ...ids.map((id) => node(id, 0, 0)),
      unlabeledConnector("a-middle", "root-a", "middle-a"),
      unlabeledConnector("b-middle", "root-b", "middle-b"),
      unlabeledConnector("a-sink", "middle-a", "sink"),
      unlabeledConnector("b-sink", "middle-b", "sink"),
    ];
    const command = {
      layout: "hierarchy",
      direction: "down",
      density: "comfortable",
      origin: { x: 25, y: 50 },
      targets: ids.map((objectId) => ({ objectId, expectedRevision: 1 })),
    } as const;

    const first = applyLayoutCommand(room(structuredClone(objects)), "alice", "agent", command);
    const second = applyLayoutCommand(room(structuredClone(objects)), "alice", "agent", command);

    expect(first.positions).toEqual(second.positions);
  });

  it("continues to reject directed cycles atomically", () => {
    const source = room([
      node("a", 0, 0),
      node("b", 0, 0),
      unlabeledConnector("a-b", "a", "b"),
      unlabeledConnector("b-a", "b", "a"),
    ]);
    const before = structuredClone(source);

    const error = captureDomainError(() =>
      applyLayoutCommand(source, "alice", "agent", {
        layout: "hierarchy",
        direction: "right",
        targets: ["a", "b"].map((objectId) => ({ objectId, expectedRevision: 1 })),
      }),
    );

    expect(error).toMatchObject({
      code: "INVALID_OPERATION",
      details: { cyclicObjectIds: ["a", "b"] },
    });
    expect(source).toEqual(before);
  });
});

describe("atomic semantic transactions", () => {
  it("aborts every object, revision, room, and agent-presence change on a stale target", () => {
    const source = room([node("a", 0, 0), node("b", 400, 0, 2)]);
    const before = structuredClone(source);

    const error = captureDomainError(() =>
      applySemanticTransaction(
        source,
        "alice",
        "agent",
        {
          commands: [
            {
              type: "update",
              objectId: "a",
              expectedRevision: 1,
              operation: "edit",
              patch: { label: "would have changed" },
            },
            {
              type: "update",
              objectId: "b",
              expectedRevision: 1,
              operation: "edit",
              patch: { label: "stale" },
            },
          ],
          diagramCommands: [],
        },
        NOW + 100,
      ),
    );

    expect(error).toMatchObject({ code: "REVISION_CONFLICT", details: { objectId: "b", currentRevision: 2 } });
    expect(source).toEqual(before);
    expect(source.participants.alice).toMatchObject({ agentActive: false, agent: { activity: null } });
  });

  it("aborts when moving a node would implicitly rewrite a foreign-leased connector", () => {
    const source = room([node("a", 0, 0), node("b", 400, 0), connector("edge", "a", "b")]);
    source.leases.edge = {
      leaseId: "bob-edge-lease",
      objectId: "edge",
      actor: actor(bob),
      operation: "connect",
      objectRevision: 1,
      acquiredAt: NOW,
      expiresAt: NOW + 4_000,
    };
    const before = structuredClone(source);

    const error = captureDomainError(() =>
      applySemanticTransaction(
        source,
        "alice",
        "agent",
        {
          commands: [{ type: "move", targets: [{ objectId: "a", expectedRevision: 1, x: 100, y: 200 }] }],
          diagramCommands: [],
        },
        NOW + 100,
      ),
    );

    expect(error).toMatchObject({ code: "OBJECT_BUSY", details: { objectId: "edge", operation: "connect" } });
    expect(source).toEqual(before);
    expect(source.participants.alice.agentActive).toBe(false);
  });

  it("reroutes an auto connector around an unrelated blocker and revisions it exactly once", () => {
    const edge = connector("edge", "source", "target");
    if (edge.kind !== "connector") throw new Error("Expected connector fixture.");
    edge.routing = {
      mode: "auto",
      kind: "straight",
      bend: 0,
      elbowMidPoint: 0.5,
      labelPosition: 0.5,
    };
    const source = persistAuthoritativeConnectorRoutes(
      room(
        [node("source", 0, 100), node("blocker", 250, 100), node("target", 500, 100), edge],
        [diagram(["source", "blocker", "target"], ["edge"])],
      ),
    );
    expect(source.objects.edge).toMatchObject({
      revision: 1,
      routing: { mode: "auto", kind: "elbow" },
    });

    const result = applySemanticTransaction(
      source,
      "alice",
      "agent",
      {
        commands: [
          {
            type: "move",
            targets: [{ objectId: "blocker", expectedRevision: 1, x: 250, y: 400 }],
          },
        ],
        diagramCommands: [],
      },
      NOW + 110,
    );

    expect(result.room.objects.edge).toMatchObject({
      revision: 2,
      routing: { mode: "auto", kind: "straight" },
      start: { objectId: "source", x: 200, y: 150 },
      end: { objectId: "target", x: 500, y: 150 },
      lastEditedBy: actor(alice, "agent"),
    });
    expect(result.changedObjectIds).toEqual(expect.arrayContaining(["blocker", "edge"]));
    expect(result.room.diagrams?.["diagram-main"]).toMatchObject({
      revision: 2,
      lastEditedBy: actor(alice, "agent"),
    });
  });

  it("redistributes persisted ports when fan-out connectors are added sequentially", () => {
    const firstEdge = connector("fan-edge-a", "hub", "leaf-a");
    if (firstEdge.kind !== "connector") throw new Error("Expected connector fixture.");
    firstEdge.routing = normalizeConnectorRouting({ mode: "auto" });
    const source = persistAuthoritativeConnectorRoutes(
      room([node("hub", 0, 100), node("leaf-a", 500, 0), node("leaf-b", 500, 200), firstEdge]),
    );
    const initialFirst = source.objects[firstEdge.id];
    const initialAnchor = structuredClone(
      initialFirst.kind === "connector"
        ? initialFirst.start.normalizedAnchor
        : null,
    );

    const result = applySemanticTransaction(
      source,
      "alice",
      "agent",
      {
        commands: [{
          type: "create",
          object: {
            id: "fan-edge-b",
            kind: "connector",
            x: 200,
            y: 150,
            width: 300,
            height: 1,
            rotation: 0,
            zIndex: 0,
            groupId: null,
            start: { x: 200, y: 150, objectId: "hub" },
            end: { x: 500, y: 250, objectId: "leaf-b" },
            routing: normalizeConnectorRouting({ mode: "auto" }),
            direction: "end",
            label: "second fan-out",
            color: "black",
          },
        }],
        diagramCommands: [],
      },
      NOW + 115,
    );
    const persistedFirst = result.room.objects[firstEdge.id];
    const persistedSecond = result.room.objects["fan-edge-b"];
    if (persistedFirst.kind !== "connector" || persistedSecond.kind !== "connector") {
      throw new Error("Expected persisted connector fixtures.");
    }

    expect(persistedFirst.start.normalizedAnchor).not.toEqual(initialAnchor);
    expect(persistedFirst.start.normalizedAnchor).not.toEqual(
      persistedSecond.start.normalizedAnchor,
    );
    expect(persistedFirst.revision).toBe(2);
    expect(persistedSecond.revision).toBe(1);
    expect(result.changedObjectIds).toEqual(
      expect.arrayContaining([firstEdge.id, persistedSecond.id]),
    );
  });

  it("rolls back a blocker move when its derived auto-route change is foreign-leased", () => {
    const edge = connector("edge", "source", "target");
    if (edge.kind !== "connector") throw new Error("Expected connector fixture.");
    edge.routing = {
      mode: "auto",
      kind: "straight",
      bend: 0,
      elbowMidPoint: 0.5,
      labelPosition: 0.5,
    };
    const source = persistAuthoritativeConnectorRoutes(
      room(
        [node("source", 0, 100), node("blocker", 250, 100), node("target", 500, 100), edge],
        [diagram(["source", "blocker", "target"], ["edge"])],
      ),
    );
    source.leases.edge = {
      leaseId: "bob-auto-route-lease",
      objectId: "edge",
      actor: actor(bob),
      operation: "connect",
      objectRevision: 1,
      acquiredAt: NOW,
      expiresAt: NOW + 4_000,
    };
    const before = structuredClone(source);

    const error = captureDomainError(() =>
      applySemanticTransaction(
        source,
        "alice",
        "agent",
        {
          commands: [
            {
              type: "move",
              targets: [{ objectId: "blocker", expectedRevision: 1, x: 250, y: 400 }],
            },
          ],
          diagramCommands: [],
        },
        NOW + 120,
      ),
    );

    expect(error).toMatchObject({ code: "OBJECT_BUSY", details: { objectId: "edge" } });
    expect(source).toEqual(before);
  });

  it("never reroutes persisted canonical connector geometry during read normalization", () => {
    const edge = connector("edge", "source", "target");
    if (edge.kind !== "connector") throw new Error("Expected connector fixture.");
    edge.routing = {
      mode: "auto",
      kind: "straight",
      bend: 0,
      elbowMidPoint: 0.5,
      labelPosition: 0.5,
    };
    const source = persistAuthoritativeConnectorRoutes(
      room(
        [node("source", 0, 100), node("blocker", 250, 100), node("target", 500, 100), edge],
        [diagram(["source", "blocker", "target"], ["edge"])],
      ),
    );
    expect(source.objects.edge).toMatchObject({ routing: { mode: "auto", kind: "elbow" } });
    source.objects.blocker = { ...source.objects.blocker, y: 500 } as CanvasObject;
    const persistedConnector = structuredClone(source.objects.edge);

    const normalized = normalizeRoomSemanticState(source);

    expect(normalized.objects.edge).toEqual(persistedConnector);
    expect(normalized.diagrams["diagram-main"].bounds.height).toBeGreaterThan(1);
  });

  it("uses bounded authoritative routing without making a high-fanout hub immovable", () => {
    const connectors = Array.from(
      { length: BULK_CONNECTOR_ROUTING_THRESHOLD + 1 },
      (_, index) => connector(`edge-${index}`, "source", "target"),
    );
    const source = room([node("source", 0, 0), node("target", 500, 0), ...connectors]);
    const result = applySemanticTransaction(
      source,
      "alice",
      "human",
      {
        commands: [
          {
            type: "move",
            targets: [{ objectId: "source", expectedRevision: 1, x: 50, y: 50 }],
          },
        ],
        diagramCommands: [],
      },
      NOW + 130,
    );

    expect(result.room.objects.source).toMatchObject({ revision: 2, x: 50, y: 50 });
    for (const connectorObject of connectors) {
      expect(result.room.objects[connectorObject.id]).toMatchObject({
        revision: 2,
        start: { objectId: "source" },
        end: { objectId: "target" },
      });
    }
  });

  it("does not reroute connectors for Diagram metadata-only edits", () => {
    const edge = connector("edge", "source", "target");
    if (edge.kind !== "connector") throw new Error("Expected connector fixture.");
    edge.routing = normalizeConnectorRouting({ mode: "auto" });
    const source = persistAuthoritativeConnectorRoutes(
      room(
        [node("source", 0, 0), node("target", 500, 0), edge],
        [diagram(["source", "target"], ["edge"])],
      ),
    );
    const beforeConnector = structuredClone(source.objects.edge);

    const result = applySemanticTransaction(
      source,
      "alice",
      "agent",
      {
        commands: [],
        diagramCommands: [
          {
            type: "diagram.update",
            diagramId: "diagram-main",
            expectedRevision: 1,
            patch: {
              title: "Renamed architecture",
              description: "Metadata changed without changing routing scope.",
              tags: ["renamed"],
            },
          },
        ],
      },
      NOW + 140,
    );

    expect(result.room.objects.edge).toEqual(beforeConnector);
    expect(result.changedObjectIds).not.toContain("edge");
    expect(result.room.diagrams["diagram-main"]).toMatchObject({
      revision: 2,
      title: "Renamed architecture",
      tags: ["renamed"],
    });
  });

  it("creates explicitly classified nodes and a first-class diagram in one commit", () => {
    const source = room([]);
    const result = applySemanticTransaction(
      source,
      "alice",
      "agent",
      {
        commands: [
          {
            type: "create",
            object: {
              id: "payments",
              kind: "shape",
              x: 10,
              y: 20,
              width: 240,
              height: 120,
              rotation: 0,
              zIndex: 1,
              groupId: null,
              shape: "rectangle",
              nodeType: "service",
              label: "Payments",
              fill: "green",
              stroke: "green",
            },
          },
        ],
        diagramCommands: [
          {
            type: "diagram.create",
            diagram: {
              id: "payments-flow",
              title: "Payments flow",
              description: "Payment service",
              diagramType: "flow",
              category: "payments",
              tags: ["critical"],
              memberObjectIds: ["payments"],
              connectorIds: [],
            },
          },
        ],
      },
      NOW + 200,
    );

    expect(result.room.roomRevision).toBe(source.roomRevision + 1);
    expect(result.room.objects.payments).toMatchObject({
      nodeType: "service",
      diagramIds: ["payments-flow"],
      revision: 1,
      createdBy: actor(alice, "agent"),
    });
    expect(result.room.diagrams?.["payments-flow"]).toMatchObject({
      revision: 1,
      bounds: { x: 10, y: 20, width: 240, height: 120 },
      createdBy: actor(alice, "agent"),
    });
  });

  it("creates and comfortably lays out a labeled Diagram atomically without double-revisioning creates", () => {
    const source = room([]);
    const result = applySemanticTransaction(
      source,
      "alice",
      "agent",
      {
        commands: [
          {
            type: "create",
            object: {
              id: "client",
              kind: "shape",
              x: 0,
              y: 0,
              width: 200,
              height: 100,
              rotation: 0,
              zIndex: 1,
              groupId: null,
              shape: "rectangle",
              nodeType: "component",
              label: "Client",
              fill: "blue",
              stroke: "blue",
            },
          },
          {
            type: "create",
            object: {
              id: "api",
              kind: "shape",
              x: 0,
              y: 0,
              width: 200,
              height: 100,
              rotation: 0,
              zIndex: 2,
              groupId: null,
              shape: "rectangle",
              nodeType: "service",
              label: "API",
              fill: "green",
              stroke: "green",
            },
          },
          {
            type: "create",
            object: {
              id: "auth",
              kind: "connector",
              x: 0,
              y: 0,
              width: 1,
              height: 1,
              rotation: 0,
              zIndex: 3,
              groupId: null,
              start: { objectId: "client", x: 100, y: 50 },
              end: { objectId: "api", x: 100, y: 50 },
              direction: "end",
              label: "authorize signed cookie",
              color: "black",
            },
          },
        ],
        diagramCommands: [
          {
            type: "diagram.create",
            diagram: {
              id: "auth-flow",
              title: "Authorization flow",
              description: "",
              diagramType: "architecture",
              category: null,
              tags: [],
              memberObjectIds: ["client", "api"],
              connectorIds: ["auth"],
            },
          },
        ],
        autoLayout: {
          layout: "flow",
          direction: "right",
          density: "comfortable",
          origin: { x: 100, y: 200 },
          targets: [
            { objectId: "client", expectedRevision: 1 },
            { objectId: "api", expectedRevision: 1 },
          ],
          diagramId: "auth-flow",
          expectedDiagramRevision: 1,
        },
      },
      NOW + 215,
    );

    expect(result.positions).toEqual([
      { objectId: "client", x: 100, y: 200 },
      { objectId: "api", x: 610, y: 200 },
    ]);
    expect(result.room.objects.client).toMatchObject({ revision: 1, x: 100, y: 200 });
    expect(result.room.objects.api).toMatchObject({ revision: 1, x: 610, y: 200 });
    expect(result.room.objects.auth).toMatchObject({
      revision: 1,
      start: { objectId: "client", x: 300, y: 250 },
      end: { objectId: "api", x: 610, y: 250 },
    });
    expect(result.room.diagrams["auth-flow"]).toMatchObject({ revision: 1 });
  });

  it("rolls back an embedded layout when a target revision is stale", () => {
    const source = room([node("api", 0, 0, 2)]);
    const before = structuredClone(source);

    const error = captureDomainError(() =>
      applySemanticTransaction(source, "alice", "agent", {
        commands: [],
        diagramCommands: [],
        autoLayout: {
          layout: "flow",
          direction: "right",
          targets: [{ objectId: "api", expectedRevision: 1 }],
        },
      }),
    );

    expect(error).toMatchObject({ code: "REVISION_CONFLICT", details: { objectId: "api" } });
    expect(source).toEqual(before);
  });

  it("rolls back an embedded layout when its derived connector is foreign-leased", () => {
    const source = room([node("client", 0, 0), node("api", 400, 0), connector("edge", "client", "api")]);
    source.leases.edge = {
      leaseId: "bob-edge-lease",
      objectId: "edge",
      actor: actor(bob),
      operation: "connect",
      objectRevision: 1,
      acquiredAt: NOW,
      expiresAt: NOW + 4_000,
    };
    const before = structuredClone(source);

    const error = captureDomainError(() =>
      applySemanticTransaction(
        source,
        "alice",
        "agent",
        {
          commands: [],
          diagramCommands: [],
          autoLayout: {
            layout: "flow",
            direction: "right",
            origin: { x: 100, y: 200 },
            targets: [
              { objectId: "client", expectedRevision: 1 },
              { objectId: "api", expectedRevision: 1 },
            ],
          },
        },
        NOW + 100,
      ),
    );

    expect(error).toMatchObject({ code: "OBJECT_BUSY", details: { objectId: "edge" } });
    expect(source).toEqual(before);
  });

  it("rejects cross-type semantic ID collisions atomically", () => {
    const source = room([node("payments", 0, 0)]);
    const before = structuredClone(source);

    const error = captureDomainError(() =>
      applySemanticTransaction(
        source,
        "alice",
        "agent",
        {
          commands: [],
          diagramCommands: [
            {
              type: "diagram.create",
              diagram: {
                id: "payments",
                title: "Payments",
                description: "",
                diagramType: "architecture",
                category: null,
                tags: [],
                memberObjectIds: [],
                connectorIds: [],
              },
            },
          ],
        },
        NOW + 225,
      ),
    );

    expect(error).toMatchObject({ code: "INVALID_OPERATION", details: { id: "payments" } });
    expect(source).toEqual(before);
  });
});

describe("derived geometry and diagram integrity", () => {
  it("includes a connector label's shared visual box in authoritative Diagram bounds", () => {
    const edge = connector("edge", "api", "worker");
    if (edge.kind !== "connector") throw new Error("Expected connector fixture.");
    edge.label = "authorizes signed guest sessions across the private room boundary ".repeat(3).trim();
    const source = room(
      [node("api", 0, 0), node("worker", 400, 0), edge],
      [diagram(["api", "worker"], ["edge"])],
    );
    const projectedEdge = source.objects.edge;
    if (projectedEdge.kind !== "connector") throw new Error("Expected connector fixture.");
    const labelBounds = connectorLabelBounds(projectedEdge.label, projectedEdge.start, projectedEdge.end);
    expect(labelBounds).not.toBeNull();
    expect(source.diagrams["diagram-main"].bounds).toEqual({
      x: 0,
      y: labelBounds!.y,
      width: 600,
      height: labelBounds!.height,
    });
  });

  it("revisions a Diagram once when member semantics change without changing membership or bounds", () => {
    const source = room(
      [node("api", 0, 0), node("worker", 400, 0), connector("edge", "api", "worker")],
      [diagram(["api", "worker"], ["edge"])],
    );
    const beforeBounds = structuredClone(source.diagrams["diagram-main"].bounds);

    const result = applySemanticTransaction(
      source,
      "alice",
      "agent",
      {
        commands: [
          {
            type: "update",
            objectId: "api",
            expectedRevision: 1,
            operation: "edit",
            patch: { label: "Public API", nodeType: "component", fill: "violet" },
          },
        ],
        diagramCommands: [],
      },
      NOW + 250,
    );

    expect(result.room.diagrams["diagram-main"]).toMatchObject({
      revision: 2,
      bounds: beforeBounds,
      updatedAt: NOW + 250,
      lastEditedBy: actor(alice, "agent"),
    });
    expect(result.changedDiagramIds).toEqual(["diagram-main"]);
  });

  it("revisions a Diagram exactly once for multiple member and implicit connector touches with unchanged outer bounds", () => {
    const source = room(
      [
        node("left", 0, 0),
        node("middle", 400, 0),
        node("right", 800, 0),
        connector("middle-right", "middle", "right"),
      ],
      [diagram(["left", "middle", "right"], ["middle-right"])],
    );
    const beforeBounds = structuredClone(source.diagrams["diagram-main"].bounds);

    const result = applySemanticTransaction(
      source,
      "alice",
      "agent",
      {
        commands: [
          { type: "move", targets: [{ objectId: "middle", expectedRevision: 1, x: 450, y: 0 }] },
          {
            type: "update",
            objectId: "left",
            expectedRevision: 1,
            operation: "edit",
            patch: { stroke: "violet" },
          },
        ],
        diagramCommands: [],
      },
      NOW + 275,
    );

    expect(result.room.diagrams["diagram-main"]).toMatchObject({
      revision: 2,
      bounds: beforeBounds,
      updatedAt: NOW + 275,
      lastEditedBy: actor(alice, "agent"),
    });
    expect(result.room.objects["middle-right"]).toMatchObject({
      revision: 2,
      lastEditedBy: actor(alice, "agent"),
    });
    expect(result.changedDiagramIds).toEqual(["diagram-main"]);
  });

  it("revisions a Diagram once for connector label and direction edits even when connector bounds stay fixed", () => {
    const source = room(
      [node("api", 0, 0), node("worker", 400, 0), connector("edge", "api", "worker")],
      [diagram(["api", "worker"], ["edge"])],
    );

    const result = applySemanticTransaction(
      source,
      "alice",
      "agent",
      {
        commands: [
          {
            type: "update",
            objectId: "edge",
            expectedRevision: 1,
            operation: "connect",
            patch: { label: "request / response", direction: "both" },
          },
        ],
        diagramCommands: [],
      },
      NOW + 290,
    );

    expect(result.room.objects.edge).toMatchObject({ revision: 2, label: "request / response", direction: "both" });
    expect(result.room.diagrams["diagram-main"]).toMatchObject({
      revision: 2,
      updatedAt: NOW + 290,
      lastEditedBy: actor(alice, "agent"),
    });
    expect(result.changedDiagramIds).toEqual(["diagram-main"]);
  });

  it("lays out a connected diagram and revisions connectors and diagram bounds exactly once", () => {
    const source = room(
      [
        node("api", 0, 0),
        node("worker", 40, 180),
        node("db", 80, 360),
        connector("api-worker", "api", "worker"),
        connector("worker-db", "worker", "db"),
      ],
      [diagram(["api", "worker", "db"], ["api-worker", "worker-db"])],
    );

    const result = applyLayoutCommand(
      source,
      "alice",
      "agent",
      {
        layout: "flow",
        direction: "right",
        targets: ["api", "worker", "db"].map((objectId) => ({ objectId, expectedRevision: 1 })),
        origin: { x: 100, y: 200 },
        primaryGap: 100,
        secondaryGap: 80,
        diagramId: "diagram-main",
        expectedDiagramRevision: 1,
      },
      NOW + 300,
    );

    expect(result.positions).toEqual([
      { objectId: "api", x: 100, y: 200 },
      { objectId: "worker", x: 500, y: 200 },
      { objectId: "db", x: 889, y: 200 },
    ]);
    expect(result.room.objects["api-worker"]).toMatchObject({
      revision: 2,
      start: { objectId: "api", x: 300, y: 250 },
      end: { objectId: "worker", x: 500, y: 250 },
      lastEditedBy: actor(alice, "agent"),
    });
    expect(result.room.objects["worker-db"]).toMatchObject({ revision: 2 });
    expect(result.room.diagrams?.["diagram-main"]).toMatchObject({
      revision: 2,
      bounds: { x: 100, y: 200, width: 989, height: 100 },
      lastEditedBy: actor(alice, "agent"),
    });
    expect(result.changedObjectIds).toEqual(expect.arrayContaining(["api", "worker", "db", "api-worker", "worker-db"]));
    expect(result.changedDiagramIds).toEqual(["diagram-main"]);
  });

  it("deleting a member detaches relationships and reconciles diagram membership and bounds", () => {
    const source = room(
      [node("api", 0, 0), node("worker", 400, 0), connector("edge", "api", "worker")],
      [diagram(["api", "worker"], ["edge"])],
    );

    const result = applySemanticTransaction(
      source,
      "alice",
      "agent",
      {
        commands: [{ type: "delete", targets: [{ objectId: "worker", expectedRevision: 1 }] }],
        diagramCommands: [],
      },
      NOW + 400,
    );

    expect(result.room.objects.worker).toBeUndefined();
    expect(result.room.objects.edge).toMatchObject({
      revision: 2,
      start: { objectId: "api" },
      end: { objectId: null },
      diagramIds: ["diagram-main"],
    });
    expect(result.room.diagrams?.["diagram-main"]).toMatchObject({
      memberObjectIds: ["api"],
      connectorIds: ["edge"],
      revision: 2,
    });
    expect(result.room.objects.api.diagramIds).toEqual(["diagram-main"]);
  });

  it("normalizes pre-diagram persisted rooms without fabricating classifications", () => {
    const legacyNode = { ...node("legacy", 0, 0) } as unknown as Record<string, unknown>;
    delete legacyNode.diagramIds;
    delete legacyNode.nodeType;
    const legacy = {
      ...room([]),
      objects: { legacy: legacyNode },
      diagrams: undefined,
    } as unknown as RoomState;

    const normalized = normalizeRoomSemanticState(legacy);

    expect(normalized.diagrams).toEqual({});
    expect(normalized.objects.legacy).toMatchObject({ diagramIds: [], nodeType: null });
  });
});
