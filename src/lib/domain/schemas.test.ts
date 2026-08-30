import { describe, expect, it } from "vitest";

import {
  agentEditPolicyRequestSchema,
  canvasCommandSchema,
  createCanvasObjectSchema,
  createRoomRequestSchema,
  joinRoomRequestSchema,
  leaseRequestSchema,
  mutationRequestSchema,
  presenceRequestSchema,
  reviewProposalDecisionSchema,
  reviewProposalListQuerySchema,
  roomTitleSchema,
  spotlightRequestSchema,
} from "./schemas";

const START = 1_000_000;

const baseObject = {
  id: "object-1",
  x: 10,
  y: 20,
  width: 200,
  height: 100,
};

describe("room request schemas", () => {
  it("trims names and applies the default room title", () => {
    expect(createRoomRequestSchema.parse({ displayName: "  Alice  " })).toEqual({
      displayName: "Alice",
      title: "Untitled Jazzboard",
    });
  });

  it("normalizes room titles and enforces the shared length boundary", () => {
    expect(roomTitleSchema.parse("  Architecture review  ")).toBe("Architecture review");
    expect(roomTitleSchema.safeParse("   ").success).toBe(false);
    expect(roomTitleSchema.safeParse("a".repeat(100)).success).toBe(true);
    expect(roomTitleSchema.safeParse("a".repeat(101)).success).toBe(false);
  });

  it("normalizes current codes, accepts legacy codes, and requires an explicit role", () => {
    expect(
      joinRoomRequestSchema.parse({ code: "abc-234", displayName: " Bob ", role: "spectator" }),
    ).toEqual({ code: "ABC234", displayName: "Bob", role: "spectator" });
    expect(
      joinRoomRequestSchema.parse({ code: "12-34", displayName: "Bob", role: "participant" }),
    ).toEqual({ code: "1234", displayName: "Bob", role: "participant" });

    expect(joinRoomRequestSchema.safeParse({ code: "42", displayName: "Bob", role: "participant" }).success).toBe(
      false,
    );
    expect(joinRoomRequestSchema.safeParse({ code: "ABO234", displayName: "Bob", role: "participant" }).success).toBe(
      false,
    );
    expect(joinRoomRequestSchema.safeParse({ code: "ABC234", displayName: "Bob", role: "host" }).success).toBe(
      false,
    );
  });

  it("strictly validates review policy, human decisions, and bounded list filters", () => {
    expect(agentEditPolicyRequestSchema.parse({ policy: "review" })).toEqual({ policy: "review" });
    expect(agentEditPolicyRequestSchema.safeParse({ policy: "disabled" }).success).toBe(false);
    expect(agentEditPolicyRequestSchema.safeParse({ policy: "review", actorKind: "human" }).success).toBe(false);

    expect(reviewProposalDecisionSchema.parse({
      action: "approve",
      expectedProposalRevision: 2,
      note: " Checked by the owner ",
    })).toEqual({ action: "approve", expectedProposalRevision: 2, note: "Checked by the owner" });
    expect(reviewProposalDecisionSchema.safeParse({ action: "approve", expectedProposalRevision: 0 }).success).toBe(false);

    expect(reviewProposalListQuerySchema.parse({
      limit: "25",
      status: "pending",
      authorParticipantId: "p_agent",
    })).toEqual({ limit: 25, status: "pending", authorParticipantId: "p_agent" });
    expect(reviewProposalListQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
  });
});

describe("semantic object schemas", () => {
  it("parses every first-demo object kind with stable defaults", () => {
    const text = createCanvasObjectSchema.parse({
      ...baseObject,
      kind: "text",
      content: "Decision",
    });
    expect(text).toMatchObject({
      rotation: 0,
      zIndex: 0,
      groupId: null,
      color: "black",
      size: "m",
      align: "start",
    });

    expect(
      createCanvasObjectSchema.parse({ ...baseObject, id: "shape", kind: "shape" }),
    ).toMatchObject({ shape: "rectangle", label: "", fill: "blue", stroke: "blue" });

    expect(
      createCanvasObjectSchema.parse({
        ...baseObject,
        id: "connector",
        kind: "connector",
        start: { x: 0, y: 0 },
        end: { x: 100, y: 100, objectId: "shape" },
      }),
    ).toMatchObject({
      start: { x: 0, y: 0, objectId: null },
      end: { x: 100, y: 100, objectId: "shape" },
      direction: "end",
    });

    expect(
      createCanvasObjectSchema.parse({
        ...baseObject,
        id: "image",
        kind: "image",
        url: "https://example.com/screenshot.png",
      }),
    ).toMatchObject({ assetId: null, alt: "", mimeType: "image/*", sourceUrl: null, locked: false });

    expect(
      createCanvasObjectSchema.parse({
        ...baseObject,
        id: "drawing",
        kind: "draw",
        points: [
          { x: 0, y: 0 },
          { x: 5, y: 5 },
        ],
      }),
    ).toMatchObject({ color: "black", size: "m" });

    expect(
      createCanvasObjectSchema.parse({
        ...baseObject,
        id: "path",
        kind: "path",
        start: { x: 0, y: 0.5 },
        segments: [{ kind: "cubic", control1: { x: 0.2, y: 0 }, control2: { x: 0.8, y: 1 }, to: { x: 1, y: 0.5 } }],
      }),
    ).toMatchObject({
      closed: false,
      fill: "none",
      stroke: "black",
      strokeWidth: 3.5,
      opacity: 1,
      lineCap: "round",
      lineJoin: "round",
      fillRule: "nonzero",
    });
  });

  it("keeps semantic identity optional for legacy objects and bounded for named vector parts", () => {
    const legacy = createCanvasObjectSchema.parse({
      ...baseObject,
      kind: "text",
      content: "Legacy note",
    });
    expect(legacy).not.toHaveProperty("semanticName");
    expect(legacy).not.toHaveProperty("semanticRole");

    const namedPart = createCanvasObjectSchema.parse({
      ...baseObject,
      id: "mona-left-eye",
      kind: "path",
      semanticName: "  Mona Lisa left eye  ",
      semanticRole: "  portrait.eye.contour  ",
      start: { x: 0, y: 0.5 },
      segments: [{ kind: "line", to: { x: 1, y: 0.5 } }],
    });
    expect(namedPart).toMatchObject({
      semanticName: "Mona Lisa left eye",
      semanticRole: "portrait.eye.contour",
    });

    expect(canvasCommandSchema.parse({
      type: "update",
      objectId: "mona-left-eye",
      expectedRevision: 1,
      operation: "edit",
      patch: { semanticName: null, semanticRole: null },
    })).toMatchObject({ patch: { semanticName: null, semanticRole: null } });
    expect(createCanvasObjectSchema.safeParse({
      ...baseObject,
      kind: "text",
      content: "Too long",
      semanticName: "n".repeat(161),
    }).success).toBe(false);
    expect(createCanvasObjectSchema.safeParse({
      ...baseObject,
      kind: "text",
      content: "Too long",
      semanticRole: "r".repeat(129),
    }).success).toBe(false);
    expect(createCanvasObjectSchema.safeParse({
      ...baseObject,
      kind: "text",
      content: "Empty identity",
      semanticName: "   ",
    }).success).toBe(false);
  });

  it("rejects non-finite geometry, non-positive dimensions, and underspecified drawings", () => {
    expect(
      createCanvasObjectSchema.safeParse({ ...baseObject, kind: "text", content: "x", x: Number.NaN }).success,
    ).toBe(false);
    expect(
      createCanvasObjectSchema.safeParse({ ...baseObject, kind: "shape", width: 0 }).success,
    ).toBe(false);
    expect(
      createCanvasObjectSchema.safeParse({
        ...baseObject,
        kind: "draw",
        points: [{ x: 0, y: 0 }],
      }).success,
    ).toBe(false);
    expect(createCanvasObjectSchema.safeParse({
      ...baseObject,
      kind: "path",
      start: { x: -0.1, y: 0 },
      segments: [{ kind: "line", to: { x: 1, y: 1 } }],
    }).success).toBe(false);
    expect(createCanvasObjectSchema.safeParse({
      ...baseObject,
      kind: "path",
      start: { x: 0, y: 0 },
      segments: [{ kind: "line", to: { x: 1, y: 1 } }],
      fill: "none",
      stroke: "none",
    }).success).toBe(false);
    expect(createCanvasObjectSchema.safeParse({
      ...baseObject,
      kind: "shape",
      fill: "chartreuse",
    }).success).toBe(false);
    expect(createCanvasObjectSchema.safeParse({
      ...baseObject,
      kind: "shape",
      fill: " BLUE ",
    }).success).toBe(false);
  });

  it("keeps normalized path starts exact while preserving connector endpoint defaults", () => {
    const pathCommand = canvasCommandSchema.parse({
      type: "update",
      objectId: "path",
      expectedRevision: 1,
      operation: "edit",
      patch: { start: { x: 0.2, y: 0.4 } },
    });
    expect(pathCommand).toMatchObject({ patch: { start: { x: 0.2, y: 0.4 } } });
    expect((pathCommand as { patch: { start: Record<string, unknown> } }).patch.start).not.toHaveProperty("objectId");

    const connectorCommand = canvasCommandSchema.parse({
      type: "update",
      objectId: "connector",
      expectedRevision: 1,
      operation: "connect",
      patch: { start: { x: 20, y: 40 } },
    });
    expect(connectorCommand).toMatchObject({ patch: { start: { x: 20, y: 40, objectId: null } } });
  });

  it("requires valid image URLs", () => {
    expect(
      createCanvasObjectSchema.safeParse({ ...baseObject, kind: "image", url: "not a URL" }).success,
    ).toBe(false);
    expect(
      createCanvasObjectSchema.safeParse({
        ...baseObject,
        kind: "image",
        url: "/api/rooms/room_private/assets?pathname=jazzboard%2Fopaque%2Fimage.png",
      }).success,
    ).toBe(true);
    expect(
      createCanvasObjectSchema.safeParse({
        ...baseObject,
        kind: "image",
        url: "/api/rooms/room_private/assets?pathname=a&assetId=b",
      }).success,
    ).toBe(false);
    expect(
      createCanvasObjectSchema.safeParse({ ...baseObject, kind: "image", url: "javascript:alert(1)" }).success,
    ).toBe(false);
  });

  it("validates lifecycle metadata without accepting server-managed timestamps", () => {
    expect(
      createCanvasObjectSchema.parse({
        ...baseObject,
        kind: "shape",
        nodeType: "decision",
        nodeMetadata: {
          kind: "decision",
          status: "accepted",
          owner: "Platform team",
          resolution: "Use signed guest sessions.",
        },
      }),
    ).toMatchObject({
      nodeType: "decision",
      nodeMetadata: { kind: "decision", status: "accepted", owner: "Platform team" },
    });

    for (const nodeMetadata of [
      { kind: "open_question", status: "open", owner: null, resolution: null },
      { kind: "decision", status: "accepted", owner: null, resolution: null },
      {
        kind: "decision",
        status: "accepted",
        owner: null,
        resolution: "Use signed sessions.",
        resolvedAt: START,
      },
    ]) {
      expect(
        createCanvasObjectSchema.safeParse({
          ...baseObject,
          kind: "shape",
          nodeType: "decision",
          nodeMetadata,
        }).success,
      ).toBe(false);
    }
  });
});

describe("canvas command schemas", () => {
  it("accepts revision-checked update, move, delete, and group commands", () => {
    const commands = [
      {
        type: "update",
        objectId: "object-1",
        expectedRevision: 1,
        patch: { content: "Updated" },
        operation: "edit",
      },
      {
        type: "move",
        targets: [{ objectId: "object-1", expectedRevision: 2, x: 300, y: 400 }],
      },
      {
        type: "delete",
        targets: [{ objectId: "object-1", expectedRevision: 3 }],
      },
      {
        type: "group",
        targets: [{ objectId: "object-1", expectedRevision: 4 }],
        groupId: "group-1",
      },
    ];

    for (const command of commands) {
      expect(canvasCommandSchema.safeParse(command).success).toBe(true);
    }
  });

  it("requires positive expected revisions and at least one batch target", () => {
    expect(
      canvasCommandSchema.safeParse({
        type: "update",
        objectId: "object-1",
        expectedRevision: 0,
        patch: { content: "Updated" },
        operation: "edit",
      }).success,
    ).toBe(false);
    expect(canvasCommandSchema.safeParse({ type: "move", targets: [] }).success).toBe(false);
    expect(canvasCommandSchema.safeParse({ type: "delete", targets: [] }).success).toBe(false);
    expect(canvasCommandSchema.safeParse({ type: "group", targets: [], groupId: null }).success).toBe(false);
  });

  it("rejects immutable, unknown, and invalid patch fields", () => {
    for (const patch of [
      { id: "replacement-id" },
      { kind: "image" },
      { revision: 99 },
      { unexpected: true },
      { width: -1 },
    ]) {
      expect(
        canvasCommandSchema.safeParse({
          type: "update",
          objectId: "object-1",
          expectedRevision: 1,
          patch,
          operation: "edit",
        }).success,
      ).toBe(false);
    }
  });

  it("accepts lease tokens on targeted mutations", () => {
    expect(
      canvasCommandSchema.parse({
        type: "move",
        targets: [
          {
            objectId: "object-1",
            expectedRevision: 2,
            leaseId: "lease-1",
            x: 30,
            y: 40,
          },
        ],
      }),
    ).toMatchObject({ targets: [{ leaseId: "lease-1" }] });
  });

  it("wraps only supported human or agent mutation origins", () => {
    const command = {
      type: "delete",
      targets: [{ objectId: "object-1", expectedRevision: 1 }],
    };
    expect(mutationRequestSchema.safeParse({ actorKind: "agent", command }).success).toBe(true);
    expect(mutationRequestSchema.safeParse({ actorKind: "site", command }).success).toBe(false);
  });
});

describe("lease, presence, and spotlight schemas", () => {
  it("validates each lease lifecycle request", () => {
    expect(
      leaseRequestSchema.safeParse({
        action: "acquire",
        actorKind: "human",
        objectId: "object-1",
        expectedRevision: 1,
        operation: "annotate",
      }).success,
    ).toBe(true);
    expect(
      leaseRequestSchema.safeParse({
        action: "renew",
        actorKind: "agent",
        objectId: "object-1",
        leaseId: "lease-1",
      }).success,
    ).toBe(true);
    expect(
      leaseRequestSchema.safeParse({
        action: "release",
        actorKind: "agent",
        objectId: "object-1",
        leaseId: "lease-1",
      }).success,
    ).toBe(true);

    expect(
      leaseRequestSchema.safeParse({
        action: "acquire",
        actorKind: "human",
        objectId: "object-1",
        expectedRevision: -1,
        operation: "edit",
      }).success,
    ).toBe(false);
  });

  it("accepts nullable cursors/viewports and bounded agent activity", () => {
    expect(
      presenceRequestSchema.parse({ actorKind: "human", cursor: null, viewport: null }),
    ).toEqual({ actorKind: "human", cursor: null, viewport: null, activity: null });

    const active = presenceRequestSchema.safeParse({
      actorKind: "agent",
      cursor: { x: 10, y: 20 },
      viewport: { x: 0, y: 0, zoom: 1.5, width: 1200, height: 800 },
      activity: {
        id: "activity-1",
        type: "drawing",
        label: "Diagramming the replacement flow",
        objectIds: ["object-1"],
        progress: 0.5,
        startedAt: START,
      },
    });
    expect(active.success).toBe(true);

    const outOfRange = presenceRequestSchema.safeParse({
      actorKind: "agent",
      cursor: null,
      viewport: null,
      activity: {
        id: "activity-1",
        type: "drawing",
        label: "Drawing",
        objectIds: [],
        progress: 1.1,
        startedAt: START,
      },
    });
    expect(outOfRange.success).toBe(false);
  });

  it("limits Spotlight actions and targets to the confirmed actor kinds", () => {
    for (const request of [
      { action: "start", target: "human" },
      { action: "start", target: "agent" },
      { action: "stop" },
      { action: "join" },
      { action: "leave" },
    ]) {
      expect(spotlightRequestSchema.safeParse(request).success).toBe(true);
    }
    expect(spotlightRequestSchema.safeParse({ action: "start", target: "room" }).success).toBe(false);
    expect(spotlightRequestSchema.safeParse({ action: "takeover" }).success).toBe(false);
  });
});
