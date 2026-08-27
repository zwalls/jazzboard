import { describe, expect, it } from "vitest";

import {
  diagramCommandSchema,
  layoutCommandSchema,
  semanticTransactionSchema,
} from "./schemas";

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
