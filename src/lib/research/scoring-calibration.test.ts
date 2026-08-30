import { describe, expect, it } from "vitest";

import calibrationCorpus from "../../../research/fixtures/scorer-calibration-v1.json";

import {
  calibrationMetricValue,
  scoreCalibrationCorpus,
  scorerCalibrationCorpusSchema,
} from "./scoring-calibration";

describe("scorer calibration corpus", () => {
  const scored = scoreCalibrationCorpus(calibrationCorpus);

  it("is a strict public synthetic corpus with no sealed prompts or answers", () => {
    const corpus = scorerCalibrationCorpusSchema.parse(calibrationCorpus);
    expect(corpus.kind).toBe("public-synthetic-calibration");
    expect(corpus.containsSealedPromptsOrAnswers).toBe(false);
    expect(JSON.stringify({
      architectureCases: corpus.architectureCases,
      drawingCases: corpus.drawingCases,
      correctionCases: corpus.correctionCases,
    })).not.toMatch(/sealedPrompt|answerKey|referenceAnswer|judgeRubric/i);

    expect(scorerCalibrationCorpusSchema.safeParse({
      ...calibrationCorpus,
      hiddenAnswers: ["not allowed"],
    }).success).toBe(false);
  });

  it("covers every requested synthetic corruption and clean controls", () => {
    const tags = new Set([
      ...scored.corpus.architectureCases.flatMap((fixture) => fixture.corruptionTags),
      ...scored.corpus.drawingCases.flatMap((fixture) => fixture.corruptionTags),
      ...scored.corpus.correctionCases.flatMap((fixture) => fixture.corruptionTags),
    ]);
    expect(tags).toEqual(new Set([
      "none",
      "overlap",
      "off_frame",
      "tiny",
      "transparent",
      "duplicate_semantics",
      "connector_direction",
      "connector_routing",
      "connector_label",
      "intentional_overlap",
      "overlap_damaged",
      "missing_part",
      "correction_regression",
      "best_state_lost",
    ]));
  });

  it("produces determinate scores for every complete calibration fixture", () => {
    for (const fixture of scored.architecture.values()) {
      expect(fixture.semantic.status).toBe("scored");
      expect(fixture.geometry.status).not.toBe("indeterminate");
    }
    for (const fixture of scored.drawing.values()) {
      expect(fixture.drawing.status).toBe("scored");
      expect(fixture.geometry.status).not.toBe("indeterminate");
    }
    for (const fixture of scored.correction.values()) {
      expect(fixture.status).toBe("scored");
    }
  });

  it("satisfies every declared monotonicity and invariance relation", () => {
    for (const expected of scored.corpus.expectedRelations) {
      const left = calibrationMetricValue(scored, expected.leftCaseId, expected.metric);
      const right = calibrationMetricValue(scored, expected.rightCaseId, expected.metric);
      if (expected.relation === "greater_than") expect(left, expected.rationale).toBeGreaterThan(right);
      else if (expected.relation === "less_than") expect(left, expected.rationale).toBeLessThan(right);
      else expect(left, expected.rationale).toBe(right);
    }
  });

  it("disqualifies off-frame, tiny, and transparent architecture semantics", () => {
    const fixture = scored.architecture.get("cal-architecture-visibility-corruptions");
    expect(fixture).toBeDefined();
    expect(fixture!.semantic.entities).toMatchObject({
      truePositive: 0,
      falsePositive: 0,
      falseNegative: 3,
      recall: 0,
    });
    expect(fixture!.semantic.disqualifiedCandidateIds).toEqual([
      "node-api-tiny",
      "node-client-off-frame",
      "node-queue-transparent",
    ]);
    expect(fixture!.geometry.blockingViolations).toBe(3);
  });

  it("penalizes duplicate architecture semantics without inflating recall", () => {
    const clean = scored.architecture.get("cal-architecture-clean")!;
    const duplicate = scored.architecture.get("cal-architecture-duplicate-semantics")!;
    expect(duplicate.semantic.entities.recall).toBe(clean.semantic.entities.recall);
    expect(duplicate.semantic.entities.precision).toBeLessThan(clean.semantic.entities.precision);
    expect(duplicate.semantic.duplicateMatchCandidateIds).toEqual(["node-client-duplicate"]);
  });

  it("separates connector semantic direction from routing and label geometry", () => {
    const clean = scored.architecture.get("cal-architecture-clean")!;
    const direction = scored.architecture.get("cal-architecture-wrong-direction")!;
    const routing = scored.architecture.get("cal-architecture-routing-label-failures")!;

    expect(direction.semantic.entities).toEqual(clean.semantic.entities);
    expect(direction.semantic.relationships.directionOrTypeErrorCount).toBe(1);
    expect(direction.semantic.relationships.f1).toBeLessThan(clean.semantic.relationships.f1);

    expect(routing.semantic.combined).toEqual(clean.semantic.combined);
    expect(routing.geometry.byCode).toMatchObject({
      CONNECTOR_OBJECT_INTRUSION: { violations: 1 },
      CONNECTOR_LABEL_COLLISION: { violations: 1 },
    });
    expect(routing.geometry.blockingViolations).toBe(2);
  });

  it("flags architecture overlap while leaving semantic fidelity invariant", () => {
    const clean = scored.architecture.get("cal-architecture-clean")!;
    const overlap = scored.architecture.get("cal-architecture-overlap")!;
    expect(overlap.semantic).toMatchObject({
      entities: clean.semantic.entities,
      relationships: clean.semantic.relationships,
      combined: clean.semantic.combined,
    });
    expect(overlap.geometry.byCode).toMatchObject({
      MEMBER_OBJECT_OVERLAP: { severity: "blocking", violations: 1, opportunities: 3 },
    });
  });

  it("does not treat deliberate drawing overlap as architecture geometry failure", () => {
    const clean = scored.drawing.get("cal-drawing-clean")!;
    const intentional = scored.drawing.get("cal-drawing-intentional-overlap")!;
    expect(intentional.drawing.partRecall).toBe(clean.drawing.partRecall);
    expect(intentional.drawing.constraintSatisfaction).toBe(1);
    expect(intentional.geometry.status).toBe("pass");
    expect(intentional.geometry.violationRate).toBe(clean.geometry.violationRate);
    expect(intentional.geometry.excludedArchitectureOnlyCodes).toEqual([
      "MEMBER_OBJECT_OVERLAP",
      "CONNECTOR_CROSSING",
    ]);
  });

  it("detects missing and visually ineligible drawing parts", () => {
    const missing = scored.drawing.get("cal-drawing-missing-part")!;
    const invisible = scored.drawing.get("cal-drawing-visibility-corruptions")!;
    expect(missing.drawing).toMatchObject({ matchedPartCount: 2, requiredPartCount: 3 });
    expect(missing.drawing.partRecall).toBeCloseTo(2 / 3);
    expect(invisible.drawing.partRecall).toBe(0);
    expect(invisible.drawing.disqualifiedCandidateIds).toEqual([
      "part-face-off-frame",
      "part-hair-tiny",
      "part-hands-transparent",
    ]);
  });

  it("deduplicates drawing parts without applying architecture precision penalties", () => {
    const clean = scored.drawing.get("cal-drawing-clean")!;
    const duplicate = scored.drawing.get("cal-drawing-duplicate-semantics")!;
    expect(duplicate.drawing.partRecall).toBe(clean.drawing.partRecall);
    expect(duplicate.drawing.duplicatePartCandidateIds).toEqual(["part-face-duplicate"]);
  });

  it("distinguishes preserved overlap from damaged required overlap", () => {
    const preserved = scored.drawing.get("cal-drawing-intentional-overlap")!;
    const damaged = scored.drawing.get("cal-drawing-overlap-damaged")!;
    expect(preserved.drawing.constraintSatisfaction).toBe(1);
    expect(damaged.drawing.constraintSatisfaction).toBe(0.5);
    expect(damaged.drawing.failedConstraintIds).toEqual(["intentional-overlap-preserved"]);
    expect(damaged.geometry.status).toBe("fail");
  });

  it("detects correction regression and loss of the best state", () => {
    const improved = scored.correction.get("cal-correction-improved")!;
    const regressed = scored.correction.get("cal-correction-regressed")!;
    expect(improved).toMatchObject({
      qualityPointDelta: 2,
      issueResolutionRate: 1,
      bestStateRetained: true,
      finalRegressedFromFirst: false,
    });
    expect(regressed).toMatchObject({
      qualityPointDelta: -1,
      bestStateRetained: false,
      finalRegressedFromFirst: true,
      bestRevisionIds: ["best"],
    });
    expect(regressed.introducedIssueKeys).toEqual(["new-occlusion"]);
    expect(regressed.degradedTransitionCount).toBe(1);
  });
});
