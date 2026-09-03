import { describe, expect, it } from "vitest";

import {
  architectureAuthoritativeAuditSchema,
  auditArchitectureAuthoritativeFacts,
  settleArchitectureQualityGate,
} from "./architecture-authoritative-audit";
import { hashCanonicalJson } from "./provenance-crypto";

function fixture() {
  return {
    taskId: "dev-architecture-test",
    publicTaskPacket: {
      kind: "architecture",
      entities: [
        { id: "client", label: "Client" },
        { id: "api", label: "API" },
        { id: "store", label: "Telemetry Store" },
      ],
      relationships: [
        { id: "client-api", fromEntityId: "client", toEntityId: "api", relationshipType: "request" },
        { id: "api-store", fromEntityId: "api", toEntityId: "store", relationshipType: "write" },
      ],
    },
    sanitizedSemanticState: {
      roomRevision: 1,
      objects: [
        { id: "node-client", kind: "shape", label: "Client", semanticName: "Client", diagramIds: ["diagram-main"] },
        { id: "node-api", kind: "shape", label: "API", semanticName: "API", diagramIds: ["diagram-main"] },
        { id: "node-store", kind: "shape", label: "Telemetry Store", semanticName: "Telemetry Store", diagramIds: ["diagram-main"] },
        {
          id: "connector-client-api",
          kind: "connector",
          semanticName: "Client sends a request to API",
          semanticRole: "request",
          label: "request",
          start: { objectId: "node-client" as string | null },
          end: { objectId: "node-api" as string | null },
          direction: "end",
        },
        {
          id: "connector-api-store",
          kind: "connector",
          semanticName: "API writes Telemetry Store",
          semanticRole: "relationship",
          label: "write",
          start: { objectId: "node-api" as string | null },
          end: { objectId: "node-store" as string | null },
          direction: "end",
        },
      ],
      diagrams: [{
        id: "diagram-main",
        memberObjectIds: ["node-client", "node-api", "node-store"],
        connectorIds: ["connector-client-api", "connector-api-store"],
      }],
    },
  };
}

describe("authoritative architecture fact audit", () => {
  it("passes exact semantic entities, directed endpoints, types, and Diagram membership", () => {
    const audit = auditArchitectureAuthoritativeFacts(fixture());
    expect(audit).toMatchObject({
      status: "pass",
      counts: {
        requiredEntities: 3,
        matchedEntities: 3,
        requiredRelationships: 2,
        matchedRelationships: 2,
        blockingFindings: 0,
      },
    });
    expect(audit.relationships.map((relationship) => relationship.typeEvidence))
      .toEqual(["confirmed", "confirmed"]);
    expect(() => architectureAuthoritativeAuditSchema.parse(audit)).not.toThrow();
  });

  it("fails a reversed endpoint even when connector prose claims the required direction", () => {
    const input = fixture();
    const connector = input.sanitizedSemanticState.objects[4]!;
    connector.start = { objectId: "node-store" };
    connector.end = { objectId: "node-api" };
    connector.semanticName = "API writes Telemetry Store";
    const audit = auditArchitectureAuthoritativeFacts(input);
    expect(audit.status).toBe("fail");
    expect(audit.relationships[1]).toMatchObject({
      status: "reversed",
      matchedConnectorId: "connector-api-store",
      typeEvidence: "confirmed",
    });
    expect(audit.blockingFindings).toContainEqual(expect.objectContaining({
      code: "RELATIONSHIP_REVERSED",
      relationshipId: "api-store",
    }));
  });

  it("fails missing, ambiguous, duplicate, and incomplete Diagram structure", () => {
    const input = fixture();
    input.sanitizedSemanticState.objects.push({
      id: "node-api-duplicate",
      kind: "shape",
      label: "API",
      semanticName: "API",
      diagramIds: ["diagram-main"],
    });
    input.sanitizedSemanticState.objects.push({
      ...input.sanitizedSemanticState.objects[3]!,
      id: "connector-client-api-duplicate",
    });
    input.sanitizedSemanticState.objects = input.sanitizedSemanticState.objects
      .filter((object) => object.id !== "node-store");
    input.sanitizedSemanticState.diagrams[0]!.memberObjectIds = [];
    const audit = auditArchitectureAuthoritativeFacts(input);
    expect(audit.status).toBe("fail");
    expect(new Set(audit.blockingFindings.map((finding) => finding.code))).toEqual(new Set([
      "ENTITY_AMBIGUOUS",
      "ENTITY_MISSING",
      "RELATIONSHIP_ENDPOINT_UNRESOLVABLE",
      "ENTITY_DIAGRAM_MEMBERSHIP_MISSING",
    ]));
  });

  it("rejects duplicated, absent-arrow, bidirectional, conflicting-type, and ungrouped relationships", () => {
    const duplicate = fixture();
    duplicate.sanitizedSemanticState.objects.push({
      ...duplicate.sanitizedSemanticState.objects[3]!,
      id: "connector-client-api-duplicate",
    });
    duplicate.sanitizedSemanticState.diagrams[0]!.connectorIds.push("connector-client-api-duplicate");
    expect(auditArchitectureAuthoritativeFacts(duplicate).blockingFindings)
      .toContainEqual(expect.objectContaining({ code: "RELATIONSHIP_DUPLICATED" }));

    const noArrow = fixture();
    noArrow.sanitizedSemanticState.objects[3]!.direction = "none";
    expect(auditArchitectureAuthoritativeFacts(noArrow).blockingFindings)
      .toContainEqual(expect.objectContaining({ code: "RELATIONSHIP_DIRECTION_UNSTATED" }));

    const both = fixture();
    both.sanitizedSemanticState.objects[3]!.direction = "both";
    expect(auditArchitectureAuthoritativeFacts(both).blockingFindings)
      .toContainEqual(expect.objectContaining({ code: "RELATIONSHIP_DIRECTION_BIDIRECTIONAL" }));

    const wrongType = fixture();
    wrongType.sanitizedSemanticState.objects[3]!.label = "write";
    wrongType.sanitizedSemanticState.objects[3]!.semanticRole = "write";
    expect(auditArchitectureAuthoritativeFacts(wrongType).blockingFindings)
      .toContainEqual(expect.objectContaining({ code: "RELATIONSHIP_TYPE_MISMATCH" }));

    const ungrouped = fixture();
    ungrouped.sanitizedSemanticState.diagrams[0]!.connectorIds = ["connector-client-api"];
    expect(auditArchitectureAuthoritativeFacts(ungrouped).blockingFindings)
      .toContainEqual(expect.objectContaining({
        code: "RELATIONSHIP_DIAGRAM_MEMBERSHIP_MISSING",
        relationshipId: "api-store",
      }));
  });

  it("does not penalize unrelated connectors or infer visual quality", () => {
    const input = fixture();
    input.sanitizedSemanticState.objects.push({
      id: "connector-decoration",
      kind: "connector",
      semanticName: "decorative relationship",
      semanticRole: "decoration",
      label: "",
      start: { objectId: "node-client" },
      end: { objectId: null as string | null },
      direction: "none",
    });
    const audit = auditArchitectureAuthoritativeFacts(input);
    expect(audit.status).toBe("pass");
    expect(audit.informational).toEqual({
      unmatchedConnectorIds: ["connector-decoration"],
      relationshipTypeEvidencePolicy: "exact_normalized_label_or_semantic_role_only_otherwise_unobservable",
      visualQualityJudged: false,
    });
  });

  it("never lets a model acceptance override failed authoritative facts", () => {
    const input = fixture();
    input.sanitizedSemanticState.objects[4]!.start = { objectId: "node-store" };
    input.sanitizedSemanticState.objects[4]!.end = { objectId: "node-api" };
    const audit = auditArchitectureAuthoritativeFacts(input);
    const result = { accepted: true, rationale: "Pixels look clean and I missed the reversed edge." };
    const gate = settleArchitectureQualityGate({
      authoritativeAudit: audit,
      resolvedModelDecision: {
        evidenceRoot: hashCanonicalJson({ exactArtifact: "fixture" }),
        accepted: true,
        result,
      },
    });
    expect(gate).toMatchObject({
      components: { authoritativeFacts: "fail", modelJudgedQuality: "pass" },
      artifactAccepted: false,
      modelAcceptanceOverridden: true,
      decisionReasons: ["AUTHORITATIVE_FACT_GATE_FAILED"],
      resolvedModelDecisionDigest: hashCanonicalJson(result),
    });
  });

  it("requires both authoritative facts and model-judged quality", () => {
    const audit = auditArchitectureAuthoritativeFacts(fixture());
    const evidenceRoot = hashCanonicalJson({ exactArtifact: "fixture" });
    const pass = settleArchitectureQualityGate({
      authoritativeAudit: audit,
      resolvedModelDecision: { evidenceRoot, accepted: true, result: { accepted: true } },
    });
    const visualFail = settleArchitectureQualityGate({
      authoritativeAudit: audit,
      resolvedModelDecision: { evidenceRoot, accepted: false, result: { accepted: false } },
    });
    expect(pass.artifactAccepted).toBe(true);
    expect(visualFail).toMatchObject({
      artifactAccepted: false,
      modelAcceptanceOverridden: false,
      decisionReasons: ["MODEL_JUDGED_QUALITY_FAILED"],
    });
  });
});
