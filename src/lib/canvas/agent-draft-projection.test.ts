import { describe, expect, it } from "vitest";

import {
  AGENT_CANVAS_DRAFT_SCHEMA_VERSION,
  type AgentCanvasDraftSnapshot,
  type AgentDraftCanvasObject,
} from "@/lib/agent-drafts/types";
import type { ActorRef, CanvasObject, Diagram } from "@/lib/domain/types";

import { projectAgentDraft } from "./agent-draft-projection";

const author: ActorRef = {
  participantId: "participant_projection",
  displayName: "Projection Builder",
  color: "#5965e8",
  kind: "agent",
};

function shape(id: string, zIndex: number): AgentDraftCanvasObject {
  return {
    authority: "draft",
    id,
    kind: "shape",
    x: zIndex * 10,
    y: 20,
    width: 120,
    height: 70,
    rotation: 0,
    zIndex,
    revision: 1,
    groupId: null,
    diagramIds: [],
    createdAt: 1,
    updatedAt: 1,
    createdBy: author,
    lastEditedBy: author,
    shape: "rectangle",
    nodeType: null,
    label: id,
    fill: "light-blue",
    stroke: "blue",
  };
}

function draft(): AgentCanvasDraftSnapshot {
  return {
    schemaVersion: AGENT_CANVAS_DRAFT_SCHEMA_VERSION,
    id: "draft_projection",
    roomId: "room_projection",
    ownerParticipantId: author.participantId,
    author,
    revision: 1,
    baselineRoomRevision: 3,
    status: "active",
    temporaryReferences: {},
    previewObjects: [shape("created-first", 8), shape("painted-first", 1)],
    previewDiagrams: [],
    metadata: null,
    createdAt: 1,
    updatedAt: 1,
    expiresAt: 50_000,
    hardExpiresAt: 100_000,
    awaitingReview: null,
  };
}

describe("projectAgentDraft", () => {
  it("shares one immutable semantic projection while preserving work order and paint order", () => {
    const candidate = draft();
    const authoritativeObjects: Readonly<Record<string, CanvasObject>> = {};
    const authoritativeDiagrams: Readonly<Record<string, Diagram>> = {};
    const first = projectAgentDraft(candidate, authoritativeObjects, authoritativeDiagrams);
    const second = projectAgentDraft(candidate, authoritativeObjects, authoritativeDiagrams);

    expect(second).toBe(first);
    expect(first?.visibleObjects.map((object) => object.id)).toEqual([
      "created-first",
      "painted-first",
    ]);
    expect(first?.objects.map(({ object }) => object.id)).toEqual([
      "painted-first",
      "created-first",
    ]);
    expect(projectAgentDraft(candidate, authoritativeObjects, {})).not.toBe(first);
    expect(projectAgentDraft(candidate, {}, authoritativeDiagrams)).not.toBe(first);
  });

  it("suppresses an ID once it is authoritative without disturbing remaining draft work", () => {
    const candidate = draft();
    const authoritative = {
      "created-first": {
        ...candidate.previewObjects[0],
        authority: undefined,
      } as unknown as CanvasObject,
    };
    const projection = projectAgentDraft(candidate, authoritative, {});

    expect(projection?.visibleObjects.map((object) => object.id)).toEqual(["painted-first"]);
    expect(projection?.objects.map(({ object }) => object.id)).toEqual(["painted-first"]);
  });
});
