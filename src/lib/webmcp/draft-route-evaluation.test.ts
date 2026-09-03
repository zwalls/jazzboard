import { describe, expect, it } from "vitest";

import type { AgentCanvasDraftSnapshot } from "@/lib/agent-drafts/types";
import { normalizeConnectorRouting } from "@/lib/domain/connector-routing";
import type { CanvasObject, Diagram, RoomState } from "@/lib/domain/types";

import { evaluateDraftRouteCandidates } from "./draft-route-evaluation";

const actor = { participantId: "agent", displayName: "Agent", color: "#4F6BED", kind: "agent" as const };

function shape(id: string, x: number, y: number): CanvasObject {
  return {
    id,
    kind: "shape",
    shape: "rectangle",
    nodeType: "component",
    label: id,
    fill: "white",
    stroke: "black",
    semanticName: id,
    semanticRole: null,
    x,
    y,
    width: 100,
    height: 80,
    rotation: 0,
    zIndex: 1,
    groupId: null,
    diagramIds: ["diagram"],
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    createdBy: actor,
    lastEditedBy: actor,
  };
}

function endpoint(objectId: string, x: number, y: number, normalizedAnchor: { x: number; y: number }) {
  return { objectId, x, y, normalizedAnchor, isPrecise: true, isExact: true, snap: "edge-point" as const };
}

function fixture() {
  const a = shape("a", 0, 0);
  const b = shape("b", 300, 200);
  const c = shape("c", 0, 200);
  const d = shape("d", 300, 0);
  const first: CanvasObject = {
    ...shape("first", 100, 40),
    kind: "connector",
    start: endpoint("a", 100, 40, { x: 1, y: 0.5 }),
    end: endpoint("b", 300, 240, { x: 0, y: 0.5 }),
    routing: normalizeConnectorRouting({ mode: "straight" }),
    direction: "end",
    label: "first",
    color: "black",
    width: 200,
    height: 200,
  };
  const second: CanvasObject = {
    ...shape("second", 100, 40),
    kind: "connector",
    start: endpoint("c", 100, 240, { x: 1, y: 0.5 }),
    end: endpoint("d", 300, 40, { x: 0, y: 0.5 }),
    routing: normalizeConnectorRouting({ mode: "straight" }),
    direction: "end",
    label: "second",
    color: "black",
    width: 200,
    height: 200,
  };
  const diagram: Diagram = {
    id: "diagram",
    title: "Crossing",
    description: "Crossing routes",
    diagramType: "architecture",
    category: null,
    tags: [],
    memberObjectIds: ["a", "b", "c", "d"],
    connectorIds: ["first", "second"],
    bounds: { x: 0, y: 0, width: 400, height: 280 },
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    createdBy: actor,
    lastEditedBy: actor,
  };
  const draft = {
    schemaVersion: 1,
    id: "draft_test",
    roomId: "room",
    ownerParticipantId: "agent",
    author: actor,
    revision: 3,
    baselineRoomRevision: 1,
    status: "active",
    temporaryReferences: { a: "a", b: "b", c: "c", d: "d", first: "first", second: "second", diagram: "diagram" },
    previewObjects: [a, b, c, d, first, second].map((object) => ({ ...object, authority: "draft" as const })),
    previewDiagrams: [{ ...diagram, authority: "draft" as const }],
    metadata: null,
    createdAt: 1,
    updatedAt: 1,
    expiresAt: 10,
    hardExpiresAt: 20,
    awaitingReview: null,
  } as AgentCanvasDraftSnapshot;
  const room = { roomRevision: 1, objects: {}, diagrams: {} } as RoomState;
  return { room, draft };
}

describe("evaluateDraftRouteCandidates", () => {
  it("compares agent-authored alternatives without mutating the draft or room", () => {
    const { room, draft } = fixture();
    const beforeRoom = structuredClone(room);
    const beforeDraft = structuredClone(draft);
    const result = evaluateDraftRouteCandidates({
      room,
      draft,
      candidates: [
        {
          candidateId: "above",
          patches: [{
            tempRef: "first",
            routing: {
              mode: "elbow",
              waypoints: [{ x: 100, y: -80 }, { x: 300, y: -80 }],
            },
          }],
        },
        {
          candidateId: "unchanged",
          patches: [{ tempRef: "first", routing: { mode: "straight" } }],
        },
      ],
    });

    expect(result.stateChanged).toBe(false);
    expect(result.baseline.connectorCrossingPairCount).toBeGreaterThan(0);
    expect(result.candidates[0]).toMatchObject({
      candidateId: "above",
      outcome: "evaluated",
      failFree: true,
      deltaFromBaseline: { connectorCrossingPairCount: expect.any(Number) },
    });
    expect(result.candidates[1]).toMatchObject({
      candidateId: "unchanged",
      outcome: "evaluated",
      deltaFromBaseline: { connectorCrossingPairCount: 0 },
    });
    expect(result.completionGate).toMatchObject({
      evaluatedCandidateCount: 2,
      invalidCandidateCount: 0,
      failFreeCandidateCount: 1,
      allEvaluatedCandidatesHaveFailures: false,
      authority: expect.stringMatching(/fail counts only.*does not rank.*pixel inspection/i),
    });
    expect(result.nextStep).toMatch(/at least one.*failCount = 0.*choose a route yourself.*inspect pixels/i);
    expect(room).toEqual(beforeRoom);
    expect(draft).toEqual(beforeDraft);
  });

  it("returns an isolated invalid result for an unresolved connector reference", () => {
    const { room, draft } = fixture();
    const result = evaluateDraftRouteCandidates({
      room,
      draft,
      candidates: [
        { candidateId: "missing", patches: [{ tempRef: "missing", routing: { mode: "straight" } }] },
        { candidateId: "valid", patches: [{ tempRef: "first", routing: { mode: "straight" } }] },
      ],
    });
    expect(result.candidates[0]).toMatchObject({ outcome: "invalid" });
    expect(result.candidates[1]).toMatchObject({ outcome: "evaluated" });
    expect(result.completionGate).toMatchObject({
      evaluatedCandidateCount: 1,
      invalidCandidateCount: 1,
      failFreeCandidateCount: 0,
      allEvaluatedCandidatesHaveFailures: true,
    });
    expect(result.nextStep).toMatch(
      /every evaluated candidate.*failCount > 0.*do not commit.*node placement or spacing.*compare and recheck again/i,
    );
  });

  it("makes an all-invalid comparison an explicit correction state", () => {
    const { room, draft } = fixture();
    const result = evaluateDraftRouteCandidates({
      room,
      draft,
      candidates: [
        { candidateId: "missing-a", patches: [{ tempRef: "missing-a", routing: { mode: "straight" } }] },
        { candidateId: "missing-b", patches: [{ tempRef: "missing-b", routing: { mode: "straight" } }] },
      ],
    });
    expect(result.completionGate).toEqual({
      evaluatedCandidateCount: 0,
      invalidCandidateCount: 2,
      failFreeCandidateCount: 0,
      allEvaluatedCandidatesHaveFailures: false,
      authority: expect.stringMatching(/deterministic fail counts only/i),
    });
    expect(result.nextStep).toMatch(/every supplied candidate was invalid.*compare again.*no route was evaluated or applied/i);
  });
});
