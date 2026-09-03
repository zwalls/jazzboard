import { z } from "zod";

import { hashCanonicalJson, type JsonValue } from "./provenance-crypto";

const stableId = z.string().trim().min(1).max(500);
const nullableText = z.string().max(100_000).nullable().optional();

const architecturePacketSchema = z.object({
  kind: z.literal("architecture"),
  entities: z.array(z.object({
    id: stableId,
    label: z.string().trim().min(1).max(500),
  }).passthrough()).min(1).max(1_000),
  relationships: z.array(z.object({
    id: stableId,
    fromEntityId: stableId,
    toEntityId: stableId,
    relationshipType: stableId,
  }).passthrough()).max(2_000),
}).passthrough();

const semanticObjectSchema = z.object({
  id: stableId,
  kind: z.string().trim().min(1).max(100),
  semanticName: nullableText,
  semanticRole: nullableText,
  label: z.string().max(100_000).optional(),
  content: z.string().max(100_000).optional(),
  alt: z.string().max(100_000).optional(),
  diagramIds: z.array(stableId).max(10_000).optional(),
  start: z.object({ objectId: stableId.nullable() }).passthrough().optional(),
  end: z.object({ objectId: stableId.nullable() }).passthrough().optional(),
  direction: z.enum(["none", "end", "both"]).optional(),
}).passthrough();

const semanticDiagramSchema = z.object({
  id: stableId,
  memberObjectIds: z.array(stableId).max(10_000),
  connectorIds: z.array(stableId).max(10_000),
}).passthrough();

const semanticStateSchema = z.object({
  objects: z.array(semanticObjectSchema).max(10_000),
  diagrams: z.array(semanticDiagramSchema).max(10_000),
}).passthrough();

const auditInputSchema = z.object({
  taskId: stableId,
  publicTaskPacket: architecturePacketSchema,
  sanitizedSemanticState: semanticStateSchema,
}).strict();

const findingCodeSchema = z.enum([
  "ENTITY_MISSING",
  "ENTITY_AMBIGUOUS",
  "ENTITY_DIAGRAM_MEMBERSHIP_MISSING",
  "RELATIONSHIP_ENDPOINT_UNRESOLVABLE",
  "RELATIONSHIP_MISSING",
  "RELATIONSHIP_REVERSED",
  "RELATIONSHIP_DUPLICATED",
  "RELATIONSHIP_DIRECTION_UNSTATED",
  "RELATIONSHIP_DIRECTION_BIDIRECTIONAL",
  "RELATIONSHIP_TYPE_MISMATCH",
  "RELATIONSHIP_DIAGRAM_MEMBERSHIP_MISSING",
]);

const auditFindingSchema = z.object({
  code: findingCodeSchema,
  entityId: stableId.nullable(),
  relationshipId: stableId.nullable(),
  objectIds: z.array(stableId).max(10_000),
  connectorIds: z.array(stableId).max(10_000),
  summary: z.string().trim().min(1).max(2_000),
}).strict();

const entityResultSchema = z.object({
  entityId: stableId,
  label: z.string(),
  status: z.enum(["matched", "missing", "ambiguous"]),
  matchedObjectId: stableId.nullable(),
  candidateObjectIds: z.array(stableId),
  diagramIds: z.array(stableId),
}).strict();

const relationshipResultSchema = z.object({
  relationshipId: stableId,
  fromEntityId: stableId,
  toEntityId: stableId,
  relationshipType: stableId,
  status: z.enum([
    "matched",
    "unresolvable",
    "missing",
    "reversed",
    "duplicated",
    "direction_unstated",
    "bidirectional",
  ]),
  matchedConnectorId: stableId.nullable(),
  candidateConnectorIds: z.array(stableId),
  typeEvidence: z.enum(["confirmed", "conflicting", "unobservable"]),
  diagramIds: z.array(stableId),
}).strict();

const auditContentSchema = z.object({
  schemaVersion: z.literal("jazzboard-architecture-authoritative-audit/v1"),
  taskId: stableId,
  inputBinding: z.object({
    publicTaskPacketDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    sanitizedSemanticStateDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  }).strict(),
  status: z.enum(["pass", "fail"]),
  counts: z.object({
    requiredEntities: z.number().int().nonnegative(),
    matchedEntities: z.number().int().nonnegative(),
    requiredRelationships: z.number().int().nonnegative(),
    matchedRelationships: z.number().int().nonnegative(),
    blockingFindings: z.number().int().nonnegative(),
  }).strict(),
  entities: z.array(entityResultSchema),
  relationships: z.array(relationshipResultSchema),
  blockingFindings: z.array(auditFindingSchema),
  informational: z.object({
    unmatchedConnectorIds: z.array(stableId),
    relationshipTypeEvidencePolicy: z.literal(
      "exact_normalized_label_or_semantic_role_only_otherwise_unobservable",
    ),
    visualQualityJudged: z.literal(false),
  }).strict(),
}).strict();

export const architectureAuthoritativeAuditSchema = auditContentSchema.extend({
  auditDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict().superRefine((audit, context) => {
  const { auditDigest: _auditDigest, ...content } = audit;
  void _auditDigest;
  if (hashCanonicalJson(content as unknown as JsonValue) !== audit.auditDigest) {
    context.addIssue({ code: "custom", path: ["auditDigest"], message: "Audit digest is invalid." });
  }
  if ((audit.blockingFindings.length === 0) !== (audit.status === "pass")
      || audit.counts.blockingFindings !== audit.blockingFindings.length) {
    context.addIssue({ code: "custom", message: "Audit status does not match its blocking findings." });
  }
});

export type ArchitectureAuthoritativeAudit = z.infer<typeof architectureAuthoritativeAuditSchema>;

const resolvedModelDecisionSchema = z.object({
  evidenceRoot: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  accepted: z.boolean(),
  result: z.record(z.string(), z.unknown()),
}).strict();

const architectureQualityGateContentSchema = z.object({
  schemaVersion: z.literal("jazzboard-architecture-quality-gate/v1"),
  authoritativeAuditDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  resolvedModelDecisionDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  evidenceRoot: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  components: z.object({
    authoritativeFacts: z.enum(["pass", "fail"]),
    modelJudgedQuality: z.enum(["pass", "fail"]),
  }).strict(),
  artifactAccepted: z.boolean(),
  decisionReasons: z.array(z.enum([
    "AUTHORITATIVE_FACT_GATE_FAILED",
    "MODEL_JUDGED_QUALITY_FAILED",
  ])).max(2),
  modelAcceptanceOverridden: z.boolean(),
}).strict();

export const architectureQualityGateSchema = architectureQualityGateContentSchema.extend({
  gateDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
}).strict().superRefine((gate, context) => {
  const { gateDigest: _gateDigest, ...content } = gate;
  void _gateDigest;
  const expectedAcceptance = gate.components.authoritativeFacts === "pass"
    && gate.components.modelJudgedQuality === "pass";
  const expectedOverride = gate.components.authoritativeFacts === "fail"
    && gate.components.modelJudgedQuality === "pass";
  if (gate.artifactAccepted !== expectedAcceptance
      || gate.modelAcceptanceOverridden !== expectedOverride
      || hashCanonicalJson(content as unknown as JsonValue) !== gate.gateDigest) {
    context.addIssue({ code: "custom", message: "Architecture quality gate is internally inconsistent." });
  }
});

export type ArchitectureQualityGate = z.infer<typeof architectureQualityGateSchema>;

/** Combines exact semantic facts with the resolved model judgment. A model may
 * reject an artifact for visual reasons, but it can never override a failed
 * authoritative fact audit. */
export function settleArchitectureQualityGate(rawInput: Readonly<{
  authoritativeAudit: unknown;
  resolvedModelDecision: unknown;
}>): ArchitectureQualityGate {
  const audit = architectureAuthoritativeAuditSchema.parse(rawInput.authoritativeAudit);
  const model = resolvedModelDecisionSchema.parse(rawInput.resolvedModelDecision);
  const factPass = audit.status === "pass";
  const reasons = [
    ...(!factPass ? ["AUTHORITATIVE_FACT_GATE_FAILED" as const] : []),
    ...(!model.accepted ? ["MODEL_JUDGED_QUALITY_FAILED" as const] : []),
  ];
  const content = architectureQualityGateContentSchema.parse({
    schemaVersion: "jazzboard-architecture-quality-gate/v1",
    authoritativeAuditDigest: audit.auditDigest,
    resolvedModelDecisionDigest: hashCanonicalJson(model.result as unknown as JsonValue),
    evidenceRoot: model.evidenceRoot,
    components: {
      authoritativeFacts: factPass ? "pass" : "fail",
      modelJudgedQuality: model.accepted ? "pass" : "fail",
    },
    artifactAccepted: factPass && model.accepted,
    decisionReasons: reasons,
    modelAcceptanceOverridden: !factPass && model.accepted,
  });
  return Object.freeze(architectureQualityGateSchema.parse({
    ...content,
    gateDigest: hashCanonicalJson(content as unknown as JsonValue),
  }));
}

function normalizeSemanticText(value: string | null | undefined) {
  return (value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function entityAliases(object: z.infer<typeof semanticObjectSchema>) {
  return new Set([
    object.semanticName,
    object.label,
    object.content,
    object.alt,
  ].map(normalizeSemanticText).filter(Boolean));
}

function objectDiagramIds(
  objectId: string,
  diagrams: readonly z.infer<typeof semanticDiagramSchema>[],
) {
  return diagrams
    .filter((diagram) => diagram.memberObjectIds.includes(objectId))
    .map((diagram) => diagram.id)
    .sort((left, right) => left.localeCompare(right));
}

function relationshipDiagramIds(
  connectorId: string,
  fromObjectId: string,
  toObjectId: string,
  diagrams: readonly z.infer<typeof semanticDiagramSchema>[],
) {
  return diagrams
    .filter((diagram) => diagram.connectorIds.includes(connectorId)
      && diagram.memberObjectIds.includes(fromObjectId)
      && diagram.memberObjectIds.includes(toObjectId))
    .map((diagram) => diagram.id)
    .sort((left, right) => left.localeCompare(right));
}

function relationshipTypeEvidence(
  connector: z.infer<typeof semanticObjectSchema>,
  expectedType: string,
  allTypes: ReadonlySet<string>,
) {
  const expected = normalizeSemanticText(expectedType);
  const candidates = [
    normalizeSemanticText(connector.label),
    normalizeSemanticText(connector.semanticRole),
  ].filter(Boolean);
  if (candidates.includes(expected)) return "confirmed" as const;
  if (candidates.some((candidate) => allTypes.has(candidate))) return "conflicting" as const;
  return "unobservable" as const;
}

/**
 * Audits facts that authoritative semantic state can settle without visual or
 * linguistic inference. It intentionally does not choose a layout, infer a
 * synonym, score pixels, or edit an artifact. Model judges remain responsible
 * for perceptual and language-dependent criteria.
 */
export function auditArchitectureAuthoritativeFacts(rawInput: unknown): ArchitectureAuthoritativeAudit {
  const input = auditInputSchema.parse(rawInput);
  const { publicTaskPacket: packet, sanitizedSemanticState: state } = input;
  const diagrams = state.diagrams;
  const findings: z.infer<typeof auditFindingSchema>[] = [];
  const semanticObjects = state.objects.filter((object) => object.kind !== "connector");
  const connectors = state.objects.filter((object) => object.kind === "connector"
    && object.start !== undefined && object.end !== undefined && object.direction !== undefined);

  const entityResults = packet.entities.map((entity) => {
    const expected = normalizeSemanticText(entity.label);
    const candidates = semanticObjects
      .filter((object) => entityAliases(object).has(expected))
      .sort((left, right) => left.id.localeCompare(right.id));
    const status = candidates.length === 0 ? "missing" as const
      : candidates.length === 1 ? "matched" as const
        : "ambiguous" as const;
    const matched = status === "matched" ? candidates[0]! : null;
    const diagramIds = matched === null
      ? []
      : objectDiagramIds(matched.id, diagrams);
    if (status !== "matched") {
      findings.push({
        code: status === "missing" ? "ENTITY_MISSING" : "ENTITY_AMBIGUOUS",
        entityId: entity.id,
        relationshipId: null,
        objectIds: candidates.map((candidate) => candidate.id),
        connectorIds: [],
        summary: status === "missing"
          ? `No authoritative semantic object exactly identifies required entity ${entity.label}.`
          : `More than one authoritative semantic object exactly identifies required entity ${entity.label}.`,
      });
    } else if (diagramIds.length === 0) {
      findings.push({
        code: "ENTITY_DIAGRAM_MEMBERSHIP_MISSING",
        entityId: entity.id,
        relationshipId: null,
        objectIds: [matched!.id],
        connectorIds: [],
        summary: `Required entity ${entity.label} is not a declared member of any semantic Diagram.`,
      });
    }
    return {
      entityId: entity.id,
      label: entity.label,
      status,
      matchedObjectId: matched?.id ?? null,
      candidateObjectIds: candidates.map((candidate) => candidate.id),
      diagramIds,
    };
  });
  const objectIdByEntityId = new Map(entityResults
    .filter((entity) => entity.status === "matched")
    .map((entity) => [entity.entityId, entity.matchedObjectId!]));
  const knownRelationshipTypes = new Set(packet.relationships.map((relationship) => (
    normalizeSemanticText(relationship.relationshipType)
  )));
  const claimedConnectorIds = new Set<string>();

  const relationshipResults = packet.relationships.map((relationship) => {
    const fromObjectId = objectIdByEntityId.get(relationship.fromEntityId);
    const toObjectId = objectIdByEntityId.get(relationship.toEntityId);
    if (!fromObjectId || !toObjectId) {
      findings.push({
        code: "RELATIONSHIP_ENDPOINT_UNRESOLVABLE",
        entityId: null,
        relationshipId: relationship.id,
        objectIds: [fromObjectId, toObjectId].filter((value): value is string => Boolean(value)),
        connectorIds: [],
        summary: `Relationship ${relationship.id} cannot be audited because one or both required entities are unresolved.`,
      });
      return {
        relationshipId: relationship.id,
        fromEntityId: relationship.fromEntityId,
        toEntityId: relationship.toEntityId,
        relationshipType: relationship.relationshipType,
        status: "unresolvable" as const,
        matchedConnectorId: null,
        candidateConnectorIds: [],
        typeEvidence: "unobservable" as const,
        diagramIds: [],
      };
    }

    const candidates = connectors.filter((connector) => {
      const start = connector.start!.objectId;
      const end = connector.end!.objectId;
      return (start === fromObjectId && end === toObjectId)
        || (start === toObjectId && end === fromObjectId);
    }).sort((left, right) => left.id.localeCompare(right.id));
    candidates.forEach((connector) => claimedConnectorIds.add(connector.id));
    const direct = candidates.filter((connector) => connector.start!.objectId === fromObjectId
      && connector.end!.objectId === toObjectId);
    const reverse = candidates.filter((connector) => connector.start!.objectId === toObjectId
      && connector.end!.objectId === fromObjectId);
    let status: z.infer<typeof relationshipResultSchema>["status"];
    let matched = direct.length === 1 && reverse.length === 0 ? direct[0]! : null;
    let finding: z.infer<typeof auditFindingSchema> | null = null;
    if (candidates.length === 0) {
      status = "missing";
      finding = {
        code: "RELATIONSHIP_MISSING",
        entityId: null,
        relationshipId: relationship.id,
        objectIds: [fromObjectId, toObjectId],
        connectorIds: [],
        summary: `No connector joins required endpoints ${relationship.fromEntityId} -> ${relationship.toEntityId}.`,
      };
    } else if (candidates.length > 1) {
      status = "duplicated";
      matched = null;
      finding = {
        code: "RELATIONSHIP_DUPLICATED",
        entityId: null,
        relationshipId: relationship.id,
        objectIds: [fromObjectId, toObjectId],
        connectorIds: candidates.map((connector) => connector.id),
        summary: `Required relationship ${relationship.id} is represented by more than one connector between its endpoints.`,
      };
    } else if (reverse.length === 1) {
      status = "reversed";
      matched = reverse[0]!;
      finding = {
        code: "RELATIONSHIP_REVERSED",
        entityId: null,
        relationshipId: relationship.id,
        objectIds: [fromObjectId, toObjectId],
        connectorIds: [matched.id],
        summary: `Connector ${matched.id} stores ${relationship.toEntityId} -> ${relationship.fromEntityId}; required direction is ${relationship.fromEntityId} -> ${relationship.toEntityId}.`,
      };
    } else if (matched?.direction === "none") {
      status = "direction_unstated";
      finding = {
        code: "RELATIONSHIP_DIRECTION_UNSTATED",
        entityId: null,
        relationshipId: relationship.id,
        objectIds: [fromObjectId, toObjectId],
        connectorIds: [matched.id],
        summary: `Connector ${matched.id} has no arrow direction for required directed relationship ${relationship.id}.`,
      };
    } else if (matched?.direction === "both") {
      status = "bidirectional";
      finding = {
        code: "RELATIONSHIP_DIRECTION_BIDIRECTIONAL",
        entityId: null,
        relationshipId: relationship.id,
        objectIds: [fromObjectId, toObjectId],
        connectorIds: [matched.id],
        summary: `Connector ${matched.id} asserts both directions for one-way required relationship ${relationship.id}.`,
      };
    } else {
      status = "matched";
    }
    if (finding !== null) findings.push(finding);

    const typeEvidence = matched === null
      ? "unobservable" as const
      : relationshipTypeEvidence(matched, relationship.relationshipType, knownRelationshipTypes);
    if (matched !== null && typeEvidence === "conflicting") {
      findings.push({
        code: "RELATIONSHIP_TYPE_MISMATCH",
        entityId: null,
        relationshipId: relationship.id,
        objectIds: [fromObjectId, toObjectId],
        connectorIds: [matched.id],
        summary: `Connector ${matched.id} declares another exact relationship type instead of ${relationship.relationshipType}.`,
      });
    }
    const diagramIds = matched === null
      ? []
      : relationshipDiagramIds(matched.id, fromObjectId, toObjectId, diagrams);
    if (matched !== null && diagramIds.length === 0) {
      findings.push({
        code: "RELATIONSHIP_DIAGRAM_MEMBERSHIP_MISSING",
        entityId: null,
        relationshipId: relationship.id,
        objectIds: [fromObjectId, toObjectId],
        connectorIds: [matched.id],
        summary: `Connector ${matched.id} and both endpoints are not declared together in any semantic Diagram.`,
      });
    }
    return {
      relationshipId: relationship.id,
      fromEntityId: relationship.fromEntityId,
      toEntityId: relationship.toEntityId,
      relationshipType: relationship.relationshipType,
      status,
      matchedConnectorId: matched?.id ?? null,
      candidateConnectorIds: candidates.map((candidate) => candidate.id),
      typeEvidence,
      diagramIds,
    };
  });

  const content = auditContentSchema.parse({
    schemaVersion: "jazzboard-architecture-authoritative-audit/v1",
    taskId: input.taskId,
    inputBinding: {
      publicTaskPacketDigest: hashCanonicalJson(packet as unknown as JsonValue),
      sanitizedSemanticStateDigest: hashCanonicalJson(state as unknown as JsonValue),
    },
    status: findings.length === 0 ? "pass" : "fail",
    counts: {
      requiredEntities: entityResults.length,
      matchedEntities: entityResults.filter((entity) => entity.status === "matched").length,
      requiredRelationships: relationshipResults.length,
      matchedRelationships: relationshipResults.filter((relationship) => relationship.status === "matched").length,
      blockingFindings: findings.length,
    },
    entities: entityResults,
    relationships: relationshipResults,
    blockingFindings: findings,
    informational: {
      unmatchedConnectorIds: connectors
        .map((connector) => connector.id)
        .filter((id) => !claimedConnectorIds.has(id))
        .sort((left, right) => left.localeCompare(right)),
      relationshipTypeEvidencePolicy: "exact_normalized_label_or_semantic_role_only_otherwise_unobservable",
      visualQualityJudged: false,
    },
  });
  return Object.freeze(architectureAuthoritativeAuditSchema.parse({
    ...content,
    auditDigest: hashCanonicalJson(content as unknown as JsonValue),
  }));
}
