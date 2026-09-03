import { describe, expect, it } from "vitest";

import {
  connectorRoutingInputSchema,
  connectorRoutingSchema,
  diagramCommandSchema,
  layoutCommandSchema,
  semanticTransactionSchema,
} from "./schemas";
import { CONNECTOR_ROUTING_LIMITS } from "./connector-routing";

describe("semantic transaction schemas", () => {
  it("parses classified nodes and first-class diagram membership in one transaction", () => {
    const transaction = semanticTransactionSchema.parse({
      commands: [
        {
          type: "create",
          object: {
            id: "api",
            kind: "shape",
            x: 0,
            y: 0,
            width: 240,
            height: 120,
            nodeType: "service",
            label: "API",
          },
        },
      ],
      diagramCommands: [
        {
          type: "diagram.create",
          diagram: {
            id: "system",
            title: "System",
            diagramType: "architecture",
            memberObjectIds: ["api"],
          },
        },
      ],
    });

    expect(transaction.commands[0]).toMatchObject({
      object: { nodeType: "service", rotation: 0, groupId: null },
    });
    expect(transaction.diagramCommands[0]).toMatchObject({
      diagram: { description: "", category: null, tags: [], connectorIds: [] },
    });
  });

  it("rejects empty transactions and empty diagram patches", () => {
    expect(semanticTransactionSchema.safeParse({ commands: [], diagramCommands: [] }).success).toBe(false);
    expect(
      diagramCommandSchema.safeParse({
        type: "diagram.update",
        diagramId: "system",
        expectedRevision: 1,
        patch: {},
      }).success,
    ).toBe(false);
  });
});

describe("connector routing schemas", () => {
  it("accepts compact routing intent and canonical resolved routing", () => {
    expect(connectorRoutingInputSchema.parse({ mode: "auto", labelPosition: 0.42 })).toEqual({
      mode: "auto",
      labelPosition: 0.42,
    });
    expect(
      connectorRoutingSchema.parse({
        mode: "auto",
        kind: "elbow",
        bend: 0,
        elbowMidPoint: 0.35,
        labelPosition: 0.42,
      }),
    ).toMatchObject({ mode: "auto", kind: "elbow" });
    expect(
      connectorRoutingInputSchema.parse({
        mode: "elbow",
        waypoints: [{ x: 120, y: -45 }, { x: 360, y: -45 }],
      }),
    ).toEqual({
      mode: "elbow",
      waypoints: [{ x: 120, y: -45 }, { x: 360, y: -45 }],
    });
  });

  it("rejects ambiguous or internally inconsistent route controls", () => {
    expect(connectorRoutingInputSchema.safeParse({ mode: "curved" }).success).toBe(false);
    expect(connectorRoutingInputSchema.safeParse({ mode: "straight", bend: 48 }).success).toBe(false);
    expect(connectorRoutingInputSchema.safeParse({ mode: "auto", elbowMidPoint: 0.2 }).success).toBe(false);
    expect(connectorRoutingInputSchema.safeParse({ mode: "auto", waypoints: [{ x: 0, y: 0 }] }).success).toBe(false);
    expect(connectorRoutingInputSchema.safeParse({ mode: "straight", waypoints: [{ x: 0, y: 0 }] }).success).toBe(false);
    expect(connectorRoutingInputSchema.safeParse({ mode: "elbow", waypoints: [] }).success).toBe(false);
    expect(
      connectorRoutingInputSchema.safeParse({
        mode: "elbow",
        waypoints: Array.from(
          { length: CONNECTOR_ROUTING_LIMITS.maxWaypoints + 1 },
          (_, index) => ({ x: index, y: 0 }),
        ),
      }).success,
    ).toBe(false);
    expect(
      connectorRoutingInputSchema.safeParse({
        mode: "elbow",
        waypoints: [{ x: CONNECTOR_ROUTING_LIMITS.maxWaypointCoordinate + 1, y: 0 }],
      }).success,
    ).toBe(false);
    expect(
      connectorRoutingSchema.safeParse({
        mode: "straight",
        kind: "curved",
        bend: 48,
        elbowMidPoint: 0.5,
        labelPosition: 0.5,
      }).success,
    ).toBe(false);
    expect(
      connectorRoutingSchema.safeParse({
        mode: "auto",
        kind: "elbow",
        bend: 0,
        elbowMidPoint: 0.5,
        labelPosition: 0.5,
        waypoints: [{ x: 10, y: 20 }],
      }).success,
    ).toBe(false);
  });
});

describe("deterministic layout schemas", () => {
  it("applies stable defaults and requires paired diagram revision context", () => {
    expect(
      layoutCommandSchema.parse({
        layout: "hierarchy",
        targets: [{ objectId: "api", expectedRevision: 3 }],
      }),
    ).toMatchObject({ direction: "right", density: "comfortable" });

    expect(
      layoutCommandSchema.safeParse({
        layout: "flow",
        targets: [{ objectId: "api", expectedRevision: 3 }],
        diagramId: "system",
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate layout targets", () => {
    expect(
      layoutCommandSchema.safeParse({
        layout: "grid",
        targets: [
          { objectId: "api", expectedRevision: 3 },
          { objectId: "api", expectedRevision: 3 },
        ],
      }).success,
    ).toBe(false);
  });

  it("accepts compact density and treats numeric gaps as optional caller minima", () => {
    expect(
      layoutCommandSchema.parse({
        layout: "flow",
        density: "compact",
        primaryGap: 120,
        targets: [{ objectId: "api", expectedRevision: 3 }],
      }),
    ).toMatchObject({ density: "compact", primaryGap: 120 });
  });
});
