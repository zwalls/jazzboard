import { z } from "zod";

import {
  architectureSemanticScoringInputSchema,
  correctionScoringInputSchema,
  drawingScoringInputSchema,
  geometryScoringInputSchema,
  scoreArchitectureSemantics,
  scoreCorrection,
  scoreDrawing,
  scoreGeometryReadability,
} from "./scoring";

const calibrationId = z.string().regex(/^cal-[a-z0-9-]{3,100}$/);

const architectureCalibrationCaseSchema = z.object({
  id: calibrationId,
  description: z.string().trim().min(10).max(500),
  corruptionTags: z.array(z.enum([
    "none",
    "overlap",
    "off_frame",
    "tiny",
    "transparent",
    "duplicate_semantics",
    "connector_direction",
    "connector_routing",
    "connector_label",
  ])).min(1).max(6),
  semanticInput: architectureSemanticScoringInputSchema,
  geometryInput: geometryScoringInputSchema,
}).strict().superRefine((fixture, context) => {
  if (fixture.geometryInput.domain !== "architecture") {
    context.addIssue({ code: "custom", path: ["geometryInput", "domain"], message: "Architecture fixtures require architecture geometry." });
  }
});

const drawingCalibrationCaseSchema = z.object({
  id: calibrationId,
  description: z.string().trim().min(10).max(500),
  corruptionTags: z.array(z.enum([
    "none",
    "intentional_overlap",
    "overlap_damaged",
    "off_frame",
    "tiny",
    "transparent",
    "duplicate_semantics",
    "missing_part",
  ])).min(1).max(6),
  drawingInput: drawingScoringInputSchema,
  geometryInput: geometryScoringInputSchema,
}).strict().superRefine((fixture, context) => {
  if (fixture.geometryInput.domain !== "drawing") {
    context.addIssue({ code: "custom", path: ["geometryInput", "domain"], message: "Drawing fixtures require drawing geometry." });
  }
});

const correctionCalibrationCaseSchema = z.object({
  id: calibrationId,
  description: z.string().trim().min(10).max(500),
  corruptionTags: z.array(z.enum(["none", "correction_regression", "best_state_lost"])).min(1).max(3),
  correctionInput: correctionScoringInputSchema,
}).strict();

export const calibrationMetricSchema = z.enum([
  "architecture.entities.precision",
  "architecture.entities.recall",
  "architecture.relationships.f1",
  "architecture.combined.f1",
  "architecture.geometry.violationRate",
  "architecture.geometry.blockingViolations",
  "drawing.partRecall",
  "drawing.constraintSatisfaction",
  "drawing.geometry.violationRate",
  "drawing.geometry.blockingViolations",
  "correction.qualityPointDelta",
  "correction.issueResolutionRate",
  "correction.bestStateRetained",
  "correction.finalRegressedFromFirst",
]);

const expectedRelationSchema = z.object({
  metric: calibrationMetricSchema,
  relation: z.enum(["greater_than", "less_than", "equal"]),
  leftCaseId: calibrationId,
  rightCaseId: calibrationId,
  rationale: z.string().trim().min(10).max(500),
}).strict();

export const scorerCalibrationCorpusSchema = z.object({
  schemaVersion: z.literal(1),
  corpusId: z.literal("jazzboard-scorer-calibration-v1"),
  kind: z.literal("public-synthetic-calibration"),
  containsSealedPromptsOrAnswers: z.literal(false),
  description: z.string().trim().min(20).max(1_000),
  architectureCases: z.array(architectureCalibrationCaseSchema).min(2).max(50),
  drawingCases: z.array(drawingCalibrationCaseSchema).min(2).max(50),
  correctionCases: z.array(correctionCalibrationCaseSchema).min(2).max(50),
  expectedRelations: z.array(expectedRelationSchema).min(1).max(200),
}).strict().superRefine((corpus, context) => {
  const allCases = [...corpus.architectureCases, ...corpus.drawingCases, ...corpus.correctionCases];
  const ids = allCases.map((fixture) => fixture.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: "custom", path: ["architectureCases"], message: "Calibration case IDs must be globally unique." });
  }
  const caseIds = new Set(ids);
  corpus.expectedRelations.forEach((relation, index) => {
    if (!caseIds.has(relation.leftCaseId) || !caseIds.has(relation.rightCaseId)) {
      context.addIssue({
        code: "custom",
        path: ["expectedRelations", index],
        message: "Expected relations must reference declared calibration cases.",
      });
    }
    const expectedPrefix = relation.metric.split(".")[0];
    for (const [field, id] of [["leftCaseId", relation.leftCaseId], ["rightCaseId", relation.rightCaseId]] as const) {
      const actualPrefix = id.startsWith("cal-architecture-")
        ? "architecture"
        : id.startsWith("cal-drawing-")
          ? "drawing"
          : id.startsWith("cal-correction-")
            ? "correction"
            : null;
      if (actualPrefix !== expectedPrefix) {
        context.addIssue({
          code: "custom",
          path: ["expectedRelations", index, field],
          message: `Metric ${relation.metric} cannot reference ${id}.`,
        });
      }
    }
  });
});

export type ScorerCalibrationCorpus = z.infer<typeof scorerCalibrationCorpusSchema>;
export type CalibrationMetric = z.infer<typeof calibrationMetricSchema>;

export type ScoredCalibrationCorpus = {
  corpus: ScorerCalibrationCorpus;
  architecture: Map<string, {
    semantic: ReturnType<typeof scoreArchitectureSemantics>;
    geometry: ReturnType<typeof scoreGeometryReadability>;
  }>;
  drawing: Map<string, {
    drawing: ReturnType<typeof scoreDrawing>;
    geometry: ReturnType<typeof scoreGeometryReadability>;
  }>;
  correction: Map<string, ReturnType<typeof scoreCorrection>>;
};

export function scoreCalibrationCorpus(raw: unknown): ScoredCalibrationCorpus {
  const corpus = scorerCalibrationCorpusSchema.parse(raw);
  return {
    corpus,
    architecture: new Map(corpus.architectureCases.map((fixture) => [fixture.id, {
      semantic: scoreArchitectureSemantics(fixture.semanticInput),
      geometry: scoreGeometryReadability(fixture.geometryInput),
    }])),
    drawing: new Map(corpus.drawingCases.map((fixture) => [fixture.id, {
      drawing: scoreDrawing(fixture.drawingInput),
      geometry: scoreGeometryReadability(fixture.geometryInput),
    }])),
    correction: new Map(corpus.correctionCases.map((fixture) => [
      fixture.id,
      scoreCorrection(fixture.correctionInput),
    ])),
  };
}

export function calibrationMetricValue(
  scored: ScoredCalibrationCorpus,
  caseId: string,
  metric: CalibrationMetric,
): number {
  if (metric.startsWith("architecture.")) {
    const fixture = scored.architecture.get(caseId);
    if (!fixture) throw new Error(`Architecture calibration case not found: ${caseId}`);
    switch (metric) {
      case "architecture.entities.precision": return fixture.semantic.entities.precision;
      case "architecture.entities.recall": return fixture.semantic.entities.recall;
      case "architecture.relationships.f1": return fixture.semantic.relationships.f1;
      case "architecture.combined.f1": return fixture.semantic.combined.f1;
      case "architecture.geometry.violationRate": return fixture.geometry.violationRate;
      case "architecture.geometry.blockingViolations": return fixture.geometry.blockingViolations;
    }
  }
  if (metric.startsWith("drawing.")) {
    const fixture = scored.drawing.get(caseId);
    if (!fixture) throw new Error(`Drawing calibration case not found: ${caseId}`);
    switch (metric) {
      case "drawing.partRecall": return fixture.drawing.partRecall;
      case "drawing.constraintSatisfaction": return fixture.drawing.constraintSatisfaction;
      case "drawing.geometry.violationRate": return fixture.geometry.violationRate;
      case "drawing.geometry.blockingViolations": return fixture.geometry.blockingViolations;
    }
  }
  const fixture = scored.correction.get(caseId);
  if (!fixture) throw new Error(`Correction calibration case not found: ${caseId}`);
  switch (metric) {
    case "correction.qualityPointDelta": return fixture.qualityPointDelta;
    case "correction.issueResolutionRate": return fixture.issueResolutionRate;
    case "correction.bestStateRetained": return fixture.bestStateRetained ? 1 : 0;
    case "correction.finalRegressedFromFirst": return fixture.finalRegressedFromFirst ? 1 : 0;
    default: throw new Error(`Unsupported calibration metric: ${metric}`);
  }
}
