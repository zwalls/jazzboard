import { describe, expect, it } from "vitest";

import developmentManifest from "../../../research/benchmarks/development-v1.json";
import developmentRubrics from "../../../research/benchmarks/development-evaluator-rubrics-v1.json";
import developmentFixtureSpecs from "../../../research/benchmarks/development-fixture-specs-v1.json";

import {
  DEFAULT_SEMANTIC_VISIBILITY_THRESHOLDS,
  acceptedArtifactScoringInputSchema,
  architectureSemanticScoringInputSchema,
  coverageAwareStatus,
  developmentBenchmarkManifestSchema,
  developmentEvaluatorRubricsManifestSchema,
  developmentFixtureSpecsManifestSchema,
  drawingScoringInputSchema,
  evidenceCoverageSchema,
  geometryScoringInputSchema,
  scoreAcceptedArtifact,
  scoreArchitectureSemantics,
  scoreCorrection,
  scoreDrawing,
  scoreEfficiency,
  scoreGeometryReadability,
  scorePresentationUx,
  validateDevelopmentBenchmarkBundle,
  type AcceptedArtifactScoringInput,
  type ArchitectureSemanticScoringInput,
  type DrawingScoringInput,
  type EvidenceCoverage,
} from "./scoring";

const completeCoverage: EvidenceCoverage = {
  status: "complete",
  analyzedOpportunities: 10,
  totalOpportunities: 10,
  reasons: [],
};

const visible = {
  inFrame: true,
  visibleFraction: 1,
  renderedAreaPx: 400,
  opacity: 1,
};

function architectureInput(): ArchitectureSemanticScoringInput {
  return {
    schemaVersion: 1,
    reference: {
      entities: [
        { id: "client", critical: true },
        { id: "api", critical: true },
        { id: "queue", critical: false },
      ],
      relationships: [
        {
          id: "client-to-api",
          fromEntityId: "client",
          toEntityId: "api",
          relationshipType: "request",
          critical: true,
        },
        {
          id: "api-to-queue",
          fromEntityId: "api",
          toEntityId: "queue",
          relationshipType: "event",
          critical: false,
        },
      ],
    },
    candidate: {
      entities: [
        { candidateId: "shape-client", matchedReferenceEntityId: "client", ...visible },
        { candidateId: "shape-api", matchedReferenceEntityId: "api", ...visible },
        { candidateId: "shape-queue", matchedReferenceEntityId: "queue", ...visible },
      ],
      relationships: [
        {
          candidateId: "edge-request",
          matchedReferenceRelationshipId: "client-to-api",
          fromCandidateEntityId: "shape-client",
          toCandidateEntityId: "shape-api",
          relationshipType: "request",
          ...visible,
        },
        {
          candidateId: "edge-event",
          matchedReferenceRelationshipId: "api-to-queue",
          fromCandidateEntityId: "shape-api",
          toCandidateEntityId: "shape-queue",
          relationshipType: "event",
          ...visible,
        },
      ],
    },
    visibilityThresholds: DEFAULT_SEMANTIC_VISIBILITY_THRESHOLDS,
    coverage: completeCoverage,
  };
}

function drawingInput(): DrawingScoringInput {
  return {
    schemaVersion: 1,
    requiredPartIds: ["face", "hair", "hands"],
    observedParts: [
      { candidateId: "face-path", matchedRequiredPartId: "face", ...visible },
      { candidateId: "hair-path", matchedRequiredPartId: "hair", ...visible },
      { candidateId: "hands-path", matchedRequiredPartId: "hands", ...visible },
    ],
    constraints: [
      { id: "overlap-preserved", expectation: "present", observed: "present" },
      { id: "judge-directed-text", expectation: "absent", observed: "absent" },
    ],
    visibilityThresholds: DEFAULT_SEMANTIC_VISIBILITY_THRESHOLDS,
    coverage: completeCoverage,
  };
}

describe("strict research schemas", () => {
  it("rejects contradictory coverage and unknown keys", () => {
    expect(evidenceCoverageSchema.safeParse({
      status: "complete",
      analyzedOpportunities: 9,
      totalOpportunities: 10,
      reasons: [],
    }).success).toBe(false);
    expect(architectureSemanticScoringInputSchema.safeParse({
      ...architectureInput(),
      answerLeak: true,
    }).success).toBe(false);
  });

  it("rejects invalid relationship references and duplicate task IDs", () => {
    const semantic = architectureInput();
    semantic.reference.relationships[0].toEntityId = "missing";
    expect(architectureSemanticScoringInputSchema.safeParse(semantic).success).toBe(false);

    const manifest = structuredClone(developmentManifest);
    manifest.tasks[1].id = manifest.tasks[0].id;
    expect(developmentBenchmarkManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it("makes partial and unavailable evidence indeterminate", () => {
    expect(coverageAwareStatus("pass", {
      status: "partial",
      analyzedOpportunities: 4,
      totalOpportunities: 5,
      reasons: ["one path requires pixel review"],
    })).toBe("indeterminate");
    expect(coverageAwareStatus("fail", completeCoverage)).toBe("fail");
  });
});

describe("architecture semantic scoring", () => {
  it("computes exact entity, relationship, combined, and critical PRF", () => {
    const score = scoreArchitectureSemantics(architectureInput());
    expect(score.status).toBe("scored");
    expect(score.entities).toMatchObject({ truePositive: 3, falsePositive: 0, falseNegative: 0, f1: 1 });
    expect(score.relationships).toMatchObject({
      truePositive: 2,
      falsePositive: 0,
      falseNegative: 0,
      directionOrTypeErrorCount: 0,
      f1: 1,
    });
    expect(score.combined.f1).toBe(1);
    expect(score.criticalRecall).toBe(1);
  });

  it("does not credit off-frame, microscopic, or transparent keyword objects", () => {
    const input = architectureInput();
    input.candidate.entities = [
      { candidateId: "off-frame-client", matchedReferenceEntityId: "client", ...visible, inFrame: false },
      { candidateId: "tiny-api", matchedReferenceEntityId: "api", ...visible, renderedAreaPx: 4 },
      { candidateId: "transparent-queue", matchedReferenceEntityId: "queue", ...visible, opacity: 0 },
    ];
    input.candidate.relationships = [];
    const score = scoreArchitectureSemantics(input);
    expect(score.entities).toMatchObject({ truePositive: 0, falsePositive: 0, falseNegative: 3, recall: 0 });
    expect(score.disqualifiedCandidateIds).toEqual([
      "off-frame-client",
      "tiny-api",
      "transparent-queue",
    ]);
  });

  it("counts duplicate keyword entities as false positives and never extra recall", () => {
    const input = architectureInput();
    input.candidate.entities.push({
      candidateId: "duplicate-client-keyword",
      matchedReferenceEntityId: "client",
      ...visible,
    });
    const score = scoreArchitectureSemantics(input);
    expect(score.entities.truePositive).toBe(3);
    expect(score.entities.falsePositive).toBe(1);
    expect(score.entities.recall).toBe(1);
    expect(score.entities.precision).toBe(0.75);
    expect(score.duplicateMatchCandidateIds).toContain("duplicate-client-keyword");
  });

  it("requires relation direction, type, and qualified endpoints", () => {
    const input = architectureInput();
    input.candidate.relationships[0].fromCandidateEntityId = "shape-api";
    input.candidate.relationships[0].toCandidateEntityId = "shape-client";
    input.candidate.relationships[1].relationshipType = "request";
    const score = scoreArchitectureSemantics(input);
    expect(score.relationships).toMatchObject({
      truePositive: 0,
      falsePositive: 2,
      falseNegative: 2,
      directionOrTypeErrorCount: 2,
    });
  });

  it("marks a numerically computed score indeterminate when coverage is partial", () => {
    const input = architectureInput();
    input.coverage = {
      status: "partial",
      analyzedOpportunities: 9,
      totalOpportunities: 10,
      reasons: ["one image region was unavailable"],
    };
    const score = scoreArchitectureSemantics(input);
    expect(score.status).toBe("indeterminate");
    expect(score.combined.f1).toBe(1);
  });
});

describe("drawing scoring", () => {
  it("scores required-part recall and constraints without penalizing artistic extras", () => {
    const input = drawingInput();
    input.observedParts.push({ candidateId: "decorative-halo", matchedRequiredPartId: null, ...visible });
    const score = scoreDrawing(input);
    expect(score.status).toBe("scored");
    expect(score.partRecall).toBe(1);
    expect(score.constraintSatisfaction).toBe(1);
    expect(score.duplicatePartCandidateIds).toEqual([]);
  });

  it("deduplicates repeated parts and disqualifies invisible semantic stuffing", () => {
    const input = drawingInput();
    input.observedParts.push(
      { candidateId: "duplicate-face", matchedRequiredPartId: "face", ...visible },
      { candidateId: "tiny-extra-hand", matchedRequiredPartId: "hands", ...visible, renderedAreaPx: 1 },
    );
    const score = scoreDrawing(input);
    expect(score.partRecall).toBe(1);
    expect(score.duplicatePartCandidateIds).toEqual(["duplicate-face"]);
    expect(score.disqualifiedCandidateIds).toEqual(["tiny-extra-hand"]);
  });

  it("supports intentional-overlap and canvas-injection constraints explicitly", () => {
    const input = drawingInput();
    input.constraints[0].observed = "present";
    input.constraints[1].observed = "present";
    const score = scoreDrawing(input);
    expect(score.failedConstraintIds).toEqual(["judge-directed-text"]);
    expect(score.constraintSatisfaction).toBe(0.5);

    input.constraints[1].observed = "not_assessed";
    expect(scoreDrawing(input).status).toBe("indeterminate");
  });

  it("uses strict drawing inputs", () => {
    expect(drawingScoringInputSchema.safeParse({ ...drawingInput(), architectureCrossings: 20 }).success).toBe(false);
  });
});

describe("normalized geometry and readability", () => {
  const base = {
    schemaVersion: 1 as const,
    findings: [
      {
        code: "UNINTENDED_OFF_FRAME" as const,
        appliesTo: "universal" as const,
        severity: "blocking" as const,
        violations: 1,
        opportunities: 10,
      },
      {
        code: "CONNECTOR_CROSSING" as const,
        appliesTo: "architecture" as const,
        severity: "warning" as const,
        violations: 4,
        opportunities: 20,
      },
      {
        code: "INTENTIONAL_OVERLAP_DAMAGED" as const,
        appliesTo: "drawing" as const,
        severity: "blocking" as const,
        violations: 0,
        opportunities: 3,
      },
    ],
    coverage: completeCoverage,
  };

  it("normalizes violations by defined opportunities", () => {
    const score = scoreGeometryReadability({ ...base, domain: "architecture" });
    expect(score).toMatchObject({
      status: "fail",
      blockingViolations: 1,
      warningViolations: 4,
      violations: 5,
      opportunities: 30,
    });
    expect(score.violationRate).toBeCloseTo(1 / 6);
  });

  it("excludes architecture-only crossing and spacing penalties from drawings", () => {
    const score = scoreGeometryReadability({ ...base, domain: "drawing" });
    expect(score.opportunities).toBe(13);
    expect(score.warningViolations).toBe(0);
    expect(score.excludedArchitectureOnlyCodes).toEqual(["CONNECTOR_CROSSING"]);
  });

  it("returns indeterminate on partial geometry despite a nominal pass", () => {
    const score = scoreGeometryReadability({
      schemaVersion: 1,
      domain: "drawing",
      findings: [{
        code: "UNINTENDED_OCCLUSION",
        appliesTo: "universal",
        severity: "blocking",
        violations: 0,
        opportunities: 3,
      }],
      coverage: {
        status: "partial",
        analyzedOpportunities: 2,
        totalOpportunities: 3,
        reasons: ["one path needs pixel adjudication"],
      },
    });
    expect(score.nominalStatus).toBe("pass");
    expect(score.status).toBe("indeterminate");
  });

  it("rejects impossible opportunity counts", () => {
    expect(geometryScoringInputSchema.safeParse({
      schemaVersion: 1,
      domain: "architecture",
      findings: [{
        code: "CONNECTOR_CROSSING",
        appliesTo: "architecture",
        severity: "warning",
        violations: 2,
        opportunities: 1,
      }],
      coverage: completeCoverage,
    }).success).toBe(false);
  });
});

describe("correction scoring", () => {
  it("measures resolution, new defects, regression, and best-state retention", () => {
    const score = scoreCorrection({
      schemaVersion: 1,
      evidenceBasis: "evaluator_recomputed",
      qualityScaleId: "human-rubric-v1-points",
      possibleIssueOpportunityCount: 20,
      revisions: [
        { revisionId: "draft", issueKeys: ["clip", "contrast"], semanticScore: 0.8, blockingViolationCount: 1, qualityValue: 4 },
        { revisionId: "best", issueKeys: ["contrast"], semanticScore: 0.9, blockingViolationCount: 0, qualityValue: 6 },
        { revisionId: "final", issueKeys: ["new-crossing"], semanticScore: 0.85, blockingViolationCount: 1, qualityValue: 5 },
      ],
      coverage: completeCoverage,
    });
    expect(score.resolvedIssueKeys).toEqual(["clip", "contrast"]);
    expect(score.introducedIssueKeys).toEqual(["new-crossing"]);
    expect(score.issueResolutionRate).toBe(1);
    expect(score.newDefectRate).toBe(0.05);
    expect(score.bestStateRetained).toBe(false);
    expect(score.bestRevisionIds).toEqual(["best"]);
    expect(score.degradedTransitionCount).toBe(1);
    expect(score.finalRegressedFromFirst).toBe(false);
  });

  it("refuses author-claimed finding history", () => {
    expect(() => scoreCorrection({
      schemaVersion: 1,
      evidenceBasis: "author_claimed" as "evaluator_recomputed",
      qualityScaleId: "quality-v1",
      possibleIssueOpportunityCount: 1,
      revisions: [
        { revisionId: "a", issueKeys: [], semanticScore: 1, blockingViolationCount: 0, qualityValue: 1 },
        { revisionId: "b", issueKeys: [], semanticScore: 1, blockingViolationCount: 0, qualityValue: 1 },
      ],
      coverage: completeCoverage,
    })).toThrow();
  });
});

describe("presentation UX and efficiency", () => {
  it("passes an active, ordered, atomic presentation and exposes ratio metrics", () => {
    const score = scorePresentationUx({
      schemaVersion: 1,
      observed: {
        totalDurationMs: 10_000,
        timeToFirstVisibleObjectMs: 500,
        visibleActivityMs: 7_000,
        revealEventCount: 10,
        semanticallyOrderedRevealCount: 9,
        flickerCount: 0,
        duplicatePresentationFrameCount: 0,
        viewportInstabilityCount: 0,
        draftAuthoritativeOverlapFrameCount: 0,
        handoffGapMs: 30,
        artificialAuthorDelayMs: 0,
        activePresentationAcceleratedOrSkipped: false,
      },
      criteria: {
        maximumTimeToFirstVisibleObjectMs: 1_000,
        minimumVisibleActivityRatio: 0.5,
        minimumRevealEventCount: 2,
        minimumSemanticRevealOrderRate: 0.8,
        maximumFlickerCount: 0,
        maximumDuplicatePresentationFrameCount: 0,
        maximumViewportInstabilityCount: 0,
        maximumHandoffGapMs: 100,
      },
      coverage: completeCoverage,
    });
    expect(score.status).toBe("pass");
    expect(score.visibleActivityRatio).toBe(0.7);
    expect(score.semanticRevealOrderRate).toBe(0.9);
  });

  it("fails overlap, artificial pacing, or accelerated evidence", () => {
    const score = scorePresentationUx({
      schemaVersion: 1,
      observed: {
        totalDurationMs: 10_000,
        timeToFirstVisibleObjectMs: 500,
        visibleActivityMs: 7_000,
        revealEventCount: 10,
        semanticallyOrderedRevealCount: 10,
        flickerCount: 0,
        duplicatePresentationFrameCount: 0,
        viewportInstabilityCount: 0,
        draftAuthoritativeOverlapFrameCount: 2,
        handoffGapMs: 30,
        artificialAuthorDelayMs: 1_000,
        activePresentationAcceleratedOrSkipped: true,
      },
      criteria: {
        maximumTimeToFirstVisibleObjectMs: 1_000,
        minimumVisibleActivityRatio: 0.5,
        minimumRevealEventCount: 2,
        minimumSemanticRevealOrderRate: 0.8,
        maximumFlickerCount: 0,
        maximumDuplicatePresentationFrameCount: 0,
        maximumViewportInstabilityCount: 0,
        maximumHandoffGapMs: 100,
      },
      coverage: completeCoverage,
    });
    expect(score.status).toBe("fail");
    expect(score.failedCriteria).toEqual(expect.arrayContaining([
      "draft_authoritative_overlap",
      "artificial_author_delay",
      "accelerated_or_skipped",
    ]));
  });

  it("does not treat an empty reveal trace as perfectly ordered progress", () => {
    const score = scorePresentationUx({
      schemaVersion: 1,
      observed: {
        totalDurationMs: 2_000,
        timeToFirstVisibleObjectMs: 1_000,
        visibleActivityMs: 1_000,
        revealEventCount: 0,
        semanticallyOrderedRevealCount: 0,
        flickerCount: 0,
        duplicatePresentationFrameCount: 0,
        viewportInstabilityCount: 0,
        draftAuthoritativeOverlapFrameCount: 0,
        handoffGapMs: 0,
        artificialAuthorDelayMs: 0,
        activePresentationAcceleratedOrSkipped: false,
      },
      criteria: {
        maximumTimeToFirstVisibleObjectMs: 1_000,
        minimumVisibleActivityRatio: 0.5,
        minimumRevealEventCount: 1,
        minimumSemanticRevealOrderRate: 0.8,
        maximumFlickerCount: 0,
        maximumDuplicatePresentationFrameCount: 0,
        maximumViewportInstabilityCount: 0,
        maximumHandoffGapMs: 100,
      },
      coverage: completeCoverage,
    });
    expect(score.semanticRevealOrderRate).toBe(1);
    expect(score.failedCriteria).toContain("reveal_event_count");
    expect(score.status).toBe("fail");
  });

  it("reports budget utilization and separates all-attempt from success-conditioned data", () => {
    const score = scoreEfficiency({
      schemaVersion: 1,
      observed: {
        toolCalls: 20,
        failedToolCalls: 2,
        retries: 1,
        roundTrips: 10,
        inputTokens: 8_000,
        outputTokens: 2_000,
        contextBytes: 40_000,
        receiptBytes: 8_000,
        wallTimeMs: 50_000,
        timeToUsefulDraftMs: 10_000,
        costUsd: 0.8,
      },
      budgets: {
        toolCalls: 25,
        roundTrips: 12,
        inputTokens: 10_000,
        outputTokens: 2_500,
        contextBytes: 50_000,
        receiptBytes: 10_000,
        wallTimeMs: 60_000,
        timeToUsefulDraftMs: 15_000,
        costUsd: 1,
      },
      successfulArtifact: false,
      coverage: completeCoverage,
    });
    expect(score.status).toBe("pass");
    expect(score.basis).toBe("all_attempt");
    expect(score.failureRate).toBe(0.1);
    expect(score.retryRate).toBe(0.05);
    expect(score.totalTokens).toBe(10_000);
    expect(score.maximumBudgetUtilization).toBeCloseTo(5 / 6);
  });
});

describe("accepted-artifact gating", () => {
  function acceptedInput(): AcceptedArtifactScoringInput {
    const gate = {
      passed: true,
      coverage: completeCoverage,
      supplementalReview: "not_needed" as const,
    };
    return {
      schemaVersion: 1,
      semantic: { ...gate, score: 0.9, threshold: 0.85 },
      geometry: { ...gate, blockingViolationCount: 0 },
      documentIntegrity: gate,
      humanQuality: gate,
      budget: gate,
    };
  }

  it("accepts only when every required gate passes with complete evidence", () => {
    expect(scoreAcceptedArtifact(acceptedInput())).toEqual({
      schemaVersion: 1,
      outcome: "accepted",
      accepted: true,
      failedGates: [],
      indeterminateGates: [],
    });
  });

  it("rejects threshold misses and blocking geometry even if passed booleans claim success", () => {
    const input = acceptedInput();
    input.semantic.score = 0.8;
    input.geometry.blockingViolationCount = 1;
    const score = scoreAcceptedArtifact(input);
    expect(score.outcome).toBe("rejected");
    expect(score.failedGates).toEqual(["semantic", "geometry"]);
  });

  it("requires supplemental review before partial deterministic coverage may pass", () => {
    const input = acceptedInput();
    input.geometry.coverage = {
      status: "partial",
      analyzedOpportunities: 8,
      totalOpportunities: 10,
      reasons: ["freehand pixels require human review"],
    };
    input.geometry.supplementalReview = "not_performed";
    expect(scoreAcceptedArtifact(input)).toMatchObject({
      outcome: "indeterminate",
      indeterminateGates: ["geometry"],
    });
    input.geometry.supplementalReview = "passed";
    expect(scoreAcceptedArtifact(input).outcome).toBe("accepted");
  });

  it("keeps accepted inputs strict", () => {
    expect(acceptedArtifactScoringInputSchema.safeParse({ ...acceptedInput(), weightedBeautyScore: 99 }).success).toBe(false);
  });
});

describe("development-v1 benchmark manifest", () => {
  it("is valid, public-only, domain-balanced, and stratum-balanced", () => {
    const manifest = developmentBenchmarkManifestSchema.parse(developmentManifest);
    expect(manifest.split).toBe("development");
    expect(manifest.answerPolicy).toBe("public-prompts-only-no-reference-answers-or-judge-rubrics");
    for (const domain of ["architecture", "drawing"] as const) {
      const tasks = manifest.tasks.filter((task) => task.domain === domain);
      expect(tasks).toHaveLength(6);
      expect(tasks.filter((task) => task.stratum === "creation")).toHaveLength(2);
      expect(tasks.filter((task) => task.stratum === "editing")).toHaveLength(2);
      expect(tasks.filter((task) => task.stratum === "stress")).toHaveLength(2);
    }
  });

  it("covers every required anti-gaming case without embedding reference answers", () => {
    const manifest = developmentBenchmarkManifestSchema.parse(developmentManifest);
    const cases = new Set(manifest.tasks.flatMap((task) => task.antiGamingCases));
    expect(cases).toEqual(new Set([
      "off_frame",
      "microscopic",
      "transparent",
      "duplicate_keyword",
      "intentional_overlap",
      "canvas_judge_injection",
    ]));
    expect(JSON.stringify(manifest)).not.toMatch(/answerKey|referenceGraph|judgeRubric|sealed/i);
  });

  it("provides a runnable public packet and author-visible criteria for every task", () => {
    const manifest = developmentBenchmarkManifestSchema.parse(developmentManifest);
    for (const task of manifest.tasks) {
      expect(task.publicTaskPacket.materials.length).toBeGreaterThan(0);
      expect(task.acceptanceCriteria.length).toBeGreaterThanOrEqual(2);
      expect(task.requiredCapabilities).toContain("visual_inspection");
      if (task.stratum === "editing" || task.stratum === "stress") {
        expect(task.initialState.kind).toBe("fixture");
      }
      if (task.domain === "architecture") {
        expect(task.publicTaskPacket.kind).toBe("architecture");
        if (task.publicTaskPacket.kind !== "architecture") throw new Error("narrowed above");
        expect(task.publicTaskPacket.entities.length).toBeGreaterThanOrEqual(2);
        expect(task.publicTaskPacket.relationships.length).toBeGreaterThan(0);
        expect(task.publicTaskPacket.uncertaintyConstraints.length).toBeGreaterThan(0);
      } else {
        expect(task.publicTaskPacket.kind).toBe("drawing");
        if (task.publicTaskPacket.kind !== "drawing") throw new Error("narrowed above");
        expect(task.publicTaskPacket.recognizableParts.length).toBeGreaterThan(0);
        expect(task.publicTaskPacket.styleDirections.length).toBeGreaterThan(0);
        expect(task.publicTaskPacket.layeringConstraints.length).toBeGreaterThan(0);
        expect(task.publicTaskPacket.creativeFreedom.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("development evaluator rubrics and fixture specs", () => {
  it("parses all three strict manifests as one linked development bundle", () => {
    const bundle = validateDevelopmentBenchmarkBundle(
      developmentManifest,
      developmentRubrics,
      developmentFixtureSpecs,
    );
    expect(bundle.rubrics.rubrics).toHaveLength(12);
    expect(bundle.fixtureSpecs.fixtures).toHaveLength(8);
    expect(bundle.fixtureSpecs.concurrentEvents).toHaveLength(2);
  });

  it("operationalizes exactly the public criteria without surprise requirements", () => {
    const bundle = validateDevelopmentBenchmarkBundle(
      developmentManifest,
      developmentRubrics,
      developmentFixtureSpecs,
    );
    for (const task of bundle.benchmark.tasks) {
      const rubric = bundle.rubrics.rubrics.find((candidate) => candidate.taskId === task.id)!;
      expect(rubric.criteria.map((criterion) => ({
        id: criterion.criterionId,
        text: criterion.publicCriterionText,
      }))).toEqual(task.acceptanceCriteria);
      const publicIds = new Set(task.acceptanceCriteria.map((criterion) => criterion.id));
      expect(rubric.geometryThresholds.every((threshold) => publicIds.has(threshold.criterionId))).toBe(true);
      expect(rubric.guardrails.every((guardrail) => publicIds.has(guardrail.criterionId))).toBe(true);
    }
  });

  it("keeps evaluator semantic references identical to public packets", () => {
    const bundle = validateDevelopmentBenchmarkBundle(
      developmentManifest,
      developmentRubrics,
      developmentFixtureSpecs,
    );
    for (const task of bundle.benchmark.tasks) {
      const rubric = bundle.rubrics.rubrics.find((candidate) => candidate.taskId === task.id)!;
      if (task.publicTaskPacket.kind === "architecture" && rubric.domain === "architecture") {
        expect(new Set(rubric.semanticReference.entities.map((entity) => entity.id)))
          .toEqual(new Set(task.publicTaskPacket.entities.map((entity) => entity.id)));
        expect(new Set(rubric.semanticReference.relationships.map((relationship) => relationship.id)))
          .toEqual(new Set(task.publicTaskPacket.relationships.map((relationship) => relationship.id)));
      } else if (task.publicTaskPacket.kind === "drawing" && rubric.domain === "drawing") {
        expect(new Set(rubric.drawingReference.requiredPartIds))
          .toEqual(new Set(task.publicTaskPacket.recognizableParts.map((part) => part.id)));
      }
    }
  });

  it("rejects a surprise evaluator criterion and evaluator-only semantic entity", () => {
    const surpriseCriterion = structuredClone(developmentRubrics);
    surpriseCriterion.rubrics[0].criteria.push({
      criterionId: "criterion-surprise",
      publicCriterionText: "Require an undisclosed load balancer in the final artifact.",
      evaluatorProcedure: "Look for an undisclosed load balancer in the exact final render.",
      passCondition: "Pass only when the undisclosed load balancer is present.",
    });
    expect(() => validateDevelopmentBenchmarkBundle(
      developmentManifest,
      surpriseCriterion,
      developmentFixtureSpecs,
    )).toThrow(/do not exactly mirror public criteria/);

    const surpriseEntity = structuredClone(
      developmentEvaluatorRubricsManifestSchema.parse(developmentRubrics),
    );
    const architectureRubric = surpriseEntity.rubrics[0];
    if (architectureRubric.domain !== "architecture") throw new Error("expected architecture rubric");
    architectureRubric.semanticReference.entities.push({ id: "hidden-load-balancer", critical: true });
    expect(() => validateDevelopmentBenchmarkBundle(
      developmentManifest,
      surpriseEntity,
      developmentFixtureSpecs,
    )).toThrow(/entity reference differs from public packet/);
  });

  it("resolves every frozen initial fixture and observable concurrent event", () => {
    const bundle = validateDevelopmentBenchmarkBundle(
      developmentManifest,
      developmentRubrics,
      developmentFixtureSpecs,
    );
    const fixtureIds = new Set(bundle.fixtureSpecs.fixtures.map((fixture) => fixture.fixtureId));
    const eventIds = new Set(bundle.fixtureSpecs.concurrentEvents.map((event) => event.eventFixtureId));
    for (const task of bundle.benchmark.tasks) {
      if (task.initialState.kind === "fixture") expect(fixtureIds).toContain(task.initialState.fixtureId);
      if (task.concurrentEventFixtureId) expect(eventIds).toContain(task.concurrentEventFixtureId);
    }
    expect(bundle.fixtureSpecs.concurrentEvents.every(
      (event) => event.observableTrigger.kind === "after_observable" && event.observableTrigger.occurrence === 1,
    )).toBe(true);
  });

  it("contains only declarative semantic setup and no room or session identifiers", () => {
    const fixtures = developmentFixtureSpecsManifestSchema.parse(developmentFixtureSpecs);
    expect(JSON.stringify(fixtures)).not.toMatch(/roomId|roomCode|sessionId|guestToken|https?:\/\//i);
    expect(fixtures.fixtures.flatMap((fixture) => fixture.preBriefSetup.operations).every(
      (operation) => ["create_object", "create_relationship", "update_object"].includes(operation.type),
    )).toBe(true);
  });

  it("requires explicit path geometry and architecture node classification", () => {
    const missingGeometry = structuredClone(developmentFixtureSpecs);
    const sailboat = missingGeometry.fixtures.find(
      (fixture) => fixture.fixtureId === "fixture-drawing-cropped-sailboat-v1",
    )!;
    const path = sailboat.preBriefSetup.operations.find(
      (operation) => operation.type === "create_object" && operation.objectKind === "path",
    );
    if (!path || path.type !== "create_object") throw new Error("expected path fixture");
    delete (path as { pathGeometry?: unknown }).pathGeometry;
    expect(developmentFixtureSpecsManifestSchema.safeParse(missingGeometry).success).toBe(false);

    const missingNodeType = structuredClone(developmentFixtureSpecs);
    const architecture = missingNodeType.fixtures.find(
      (fixture) => fixture.fixtureId === "fixture-architecture-primary-path-v1",
    )!;
    const service = architecture.preBriefSetup.operations.find(
      (operation) => operation.type === "create_object" && operation.semanticRole === "service",
    );
    if (!service || service.type !== "create_object") throw new Error("expected architecture service");
    service.nodeType = null;
    expect(developmentFixtureSpecsManifestSchema.safeParse(missingNodeType).success).toBe(false);
  });

  it("keeps rubric and fixture manifests strict", () => {
    expect(developmentEvaluatorRubricsManifestSchema.safeParse({
      ...developmentRubrics,
      sealedAnswers: [],
    }).success).toBe(false);
    expect(developmentFixtureSpecsManifestSchema.safeParse({
      ...developmentFixtureSpecs,
      roomId: "not-allowed",
    }).success).toBe(false);
  });
});
