import { describe, expect, it } from "vitest";

import {
  AGENT_CANVAS_DRAFT_SCHEMA_VERSION,
  isAgentCanvasDraftEvent,
} from "./types";
import {
  replaceAgentCanvasDraftRequestSchema,
  stageAgentCanvasDraftRequestSchema,
} from "./schemas";

describe("agent canvas draft contracts", () => {
  it("accepts compact invalidations without embedding draft contents", () => {
    const event = {
      schemaVersion: AGENT_CANVAS_DRAFT_SCHEMA_VERSION,
      id: "draft_event_1",
      roomId: "room_1",
      occurredAt: 100,
      type: "draft.upsert",
      draftId: "draft_1",
      ownerParticipantId: "p_1",
      revision: 3,
      status: "awaiting_review",
      expiresAt: 1_000,
    };

    expect(isAgentCanvasDraftEvent(event)).toBe(true);
    expect(JSON.stringify(event)).not.toContain("transaction");
    expect(JSON.stringify(event)).not.toContain("previewObjects");
    expect(isAgentCanvasDraftEvent({ ...event, revision: 0 })).toBe(false);
    expect(isAgentCanvasDraftEvent({ ...event, status: "unknown" })).toBe(false);

    const committed = {
      schemaVersion: AGENT_CANVAS_DRAFT_SCHEMA_VERSION,
      id: "draft_event_2",
      roomId: "room_1",
      occurredAt: 200,
      type: "draft.removed",
      draftId: "draft_1",
      revision: 4,
      reason: "committed",
      authoritativeRoomRevision: 12,
    };
    expect(isAgentCanvasDraftEvent(committed)).toBe(true);
    expect(isAgentCanvasDraftEvent({ ...committed, authoritativeRoomRevision: undefined })).toBe(false);
    expect(isAgentCanvasDraftEvent({ ...committed, authoritativeRoomRevision: -1 })).toBe(false);
    expect(isAgentCanvasDraftEvent({ ...committed, reason: "discarded" })).toBe(false);
  });

  it("validates bounded, one-to-one temporary references", () => {
    const request = {
      draftId: "draft_refs",
      baselineRoomRevision: 1,
      transaction: {
        commands: [{
          type: "create",
          object: {
            id: "object_a",
            kind: "text",
            x: 0,
            y: 0,
            width: 120,
            height: 60,
            content: "A",
          },
        }],
        diagramCommands: [],
      },
      temporaryReferences: { node_a: "object_a" },
    };

    expect(stageAgentCanvasDraftRequestSchema.parse(request).temporaryReferences).toEqual({ node_a: "object_a" });
    expect(stageAgentCanvasDraftRequestSchema.safeParse({
      ...request,
      temporaryReferences: { node_a: "object_a", node_b: "object_a" },
    }).success).toBe(false);
  });

  it("defaults draft replacements and accepts explicit targeted patches", () => {
    const request = {
      expectedDraftRevision: 2,
      baselineRoomRevision: 1,
      transaction: {
        commands: [{
          type: "create",
          object: {
            id: "connector_a",
            kind: "connector",
            x: 0,
            y: 0,
            width: 120,
            height: 1,
            start: { x: 0, y: 0, objectId: null },
            end: { x: 120, y: 0, objectId: null },
          },
        }],
        diagramCommands: [],
      },
      temporaryReferences: { connector_a: "connector_a" },
    };

    expect(replaceAgentCanvasDraftRequestSchema.parse(request).updateMode).toBe("replace");
    expect(replaceAgentCanvasDraftRequestSchema.parse({ ...request, updateMode: "patch" }).updateMode)
      .toBe("patch");
    expect(replaceAgentCanvasDraftRequestSchema.safeParse({ ...request, updateMode: "merge" }).success)
      .toBe(false);
  });
});
