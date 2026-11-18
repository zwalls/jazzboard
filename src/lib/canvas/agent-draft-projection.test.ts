import { describe, expect, it } from "vitest";

import {
  AGENT_CANVAS_DRAFT_SCHEMA_VERSION,
  type AgentCanvasDraftSnapshot,
  type AgentDraftCanvasObject,
} from "@/lib/agent-drafts/types";
import type { ActorRef, CanvasObject, ConnectorObject, Diagram } from "@/lib/domain/types";

import { projectAgentDraft } from "./agent-draft-projection";
import { buildSemanticScene } from "./semantic-scene";

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

  it("projects an exact committed presentation but yields immediately to a later edit", () => {
    const candidate = { ...draft(), status: "presenting" as const };
    const exact = {
      ...candidate.previewObjects[0],
      authority: undefined,
    } as unknown as CanvasObject;
    const first = projectAgentDraft(candidate, { [exact.id]: exact }, {});
    expect(first?.visibleObjects.map((object) => object.id)).toEqual(["created-first"]);

    const edited = { ...exact, revision: exact.revision + 1 };
    const afterEdit = projectAgentDraft(candidate, { [edited.id]: edited }, {});
    expect(afterEdit).toBeNull();

    const afterDelete = projectAgentDraft(candidate, {}, {});
    expect(afterDelete).toBeNull();

    const recreated = { ...exact, createdAt: exact.createdAt + 1 };
    const afterRecreate = projectAgentDraft(candidate, { [recreated.id]: recreated }, {});
    expect(afterRecreate).toBeNull();
  });

  it("renders only draft artwork and uses the latest visible or authoritative connector endpoints", () => {
    const previewStart = { ...shape("start", 1), rotation: Math.PI / 4 };
    const previewEnd = shape("end", 2);
    const connector: ConnectorObject & { authority: "draft" } = {
      ...shape("link", 3),
      kind: "connector",
      start: { x: 70, y: 100, objectId: previewStart.id, normalizedAnchor: { x: 1, y: 0.5 } },
      end: { x: 350, y: 190, objectId: previewEnd.id, normalizedAnchor: { x: 0, y: 0.5 } },
      routing: { mode: "elbow", kind: "elbow", bend: 0, elbowMidPoint: 0.6, labelPosition: 0.4 },
      label: "Labeled elbow",
      direction: "end",
      color: "blue",
    };
    const candidate = { ...draft(), status: "presenting" as const, previewObjects: [connector, previewEnd, previewStart] };
    const oldStart = { ...previewStart, rotation: 0 };
    const editedEnd = { ...previewEnd, revision: 2, rotation: Math.PI / 2 };
    const unrelated = { ...connector, id: "unrelated" };
    const authoritative = { start: oldStart, end: editedEnd, link: connector, unrelated };
    const full = buildSemanticScene({
      id: candidate.roomId, roomRevision: candidate.baselineRoomRevision, diagrams: {},
      objects: { ...authoritative, start: previewStart, link: connector },
    });
    let unrelatedRoutingReads = 0;
    Object.defineProperty(unrelated, "routing", {
      get: () => { unrelatedRoutingReads++; return connector.routing; },
    });

    const projection = projectAgentDraft(candidate, authoritative);
    expect(projection?.visibleObjects).toEqual([connector, previewStart]);
    expect(projection?.objects).toEqual([full.objectsById.start, full.objectsById.link]);
    expect(projection?.connectorRoutes).toEqual({ link: full.connectorRoutes.link });
    expect(unrelatedRoutingReads).toBe(0);

    const changedEnd = { ...authoritative, end: { ...editedEnd, rotation: 0 } };
    const changed = projectAgentDraft(candidate, changedEnd);
    expect(changed?.connectorRoutes.link.points).not.toEqual(projection?.connectorRoutes.link.points);
    const withoutEnd = { start: oldStart, link: connector };
    const deleted = projectAgentDraft(candidate, withoutEnd);
    const fallback = buildSemanticScene({
      id: candidate.roomId, roomRevision: candidate.baselineRoomRevision, diagrams: {},
      objects: { ...withoutEnd, start: previewStart },
    });
    expect(deleted?.connectorRoutes.link).toEqual(fallback.connectorRoutes.link);
  });
});
