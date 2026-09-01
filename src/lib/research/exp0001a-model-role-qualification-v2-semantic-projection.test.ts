// @vitest-environment node

import { describe, expect, it } from "vitest";

import {
  parseQualificationV2SanitizedSemanticState,
  projectQualificationV2SanitizedSemanticState,
} from "./exp0001a-model-role-qualification-v2-semantic-projection";
import { canonicalJson } from "./provenance-crypto";

const baseObject = {
  id: "object-service",
  kind: "shape",
  semanticName: "Room API",
  semanticRole: "service",
  x: 20,
  y: 40,
  width: 180,
  height: 90,
  rotation: 0,
  zIndex: 1,
  revision: 3,
  groupId: null,
  diagramIds: ["diagram-architecture"],
  shape: "rectangle",
  nodeType: "service",
  nodeMetadata: null,
  label: "Room API",
  fill: "#ffffff",
  stroke: "#111111",
};

describe("qualification-v2 semantic review projection", () => {
  it("keeps only reviewer-needed semantic fields from realistic attributed objects and diagrams", () => {
    const projected = projectQualificationV2SanitizedSemanticState({
      ok: true,
      tool: "read_room_state",
      data: {
        room: { id: "room_private_secret", code: "ABC234", roomRevision: 9, createdBy: "participant-host" },
        participants: [{ participantId: "participant-author", displayName: "Terra Author" }],
        sessions: [{ sessionId: "session-secret" }],
        objects: [{
          ...baseObject,
          createdAt: 123,
          updatedAt: 456,
          createdBy: { participantId: "participant-author", displayName: "Terra Author" },
          lastEditedBy: { participantId: "participant-editor", displayName: "Editor" },
          futureMetadata: { owner: "secret-owner", creator: "secret-creator" },
        }],
        diagrams: [{
          id: "diagram-architecture",
          title: "Jazzboard architecture",
          description: "Public semantic description",
          diagramType: "architecture",
          category: "system",
          tags: ["webmcp"],
          memberObjectIds: ["object-service"],
          connectorIds: [],
          bounds: { x: 20, y: 40, width: 180, height: 90 },
          revision: 2,
          createdAt: 123,
          updatedAt: 456,
          createdBy: { participantId: "participant-author", displayName: "Terra Author" },
          lastEditedBy: { participantId: "participant-editor", displayName: "Editor" },
          owner: "secret-owner",
        }],
      },
    });
    expect(projected).toMatchObject({ roomRevision: 9, objects: [baseObject] });
    const json = canonicalJson(projected);
    expect(json).not.toMatch(/room_private|ABC234|participant|session|displayName|createdAt|updatedAt|createdBy|lastEditedBy|owner|creator/i);
    expect(parseQualificationV2SanitizedSemanticState(projected)).toEqual(projected);
  });

  it("rejects any unknown or attribution field at the blinded boundary", () => {
    const projected = projectQualificationV2SanitizedSemanticState({
      room: { roomRevision: 9 }, objects: [baseObject], diagrams: [],
    });
    expect(() => parseQualificationV2SanitizedSemanticState({
      ...projected,
      objects: [{ ...projected.objects[0], lastEditedBy: { displayName: "leak" } }],
    })).toThrow();
    expect(() => parseQualificationV2SanitizedSemanticState({
      ...projected,
      diagrams: [{
        id: "diagram-architecture",
        title: "Architecture",
        description: "",
        diagramType: "architecture",
        category: null,
        tags: [],
        memberObjectIds: [],
        connectorIds: [],
        bounds: { x: 0, y: 0, width: 0, height: 0 },
        revision: 1,
        createdBy: "secret",
      }],
    })).toThrow();
  });
});
