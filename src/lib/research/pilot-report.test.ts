import { describe, expect, it } from "vitest";

import { createArtifactIndex, sealAttempt, transitionAttempt } from "./attempt-ledger";
import type { AttemptRegistry, RunSpec } from "./attempt-schemas";
import { initializePilotRegistry } from "./pilot-coordinator";
import {
  createPilotReport,
  verifyPilotReport,
  type PilotAcceptanceSummary,
  type PilotReportInput,
  type PilotScorerSummary,
} from "./pilot-report";
import { createPilotRandomizationManifest } from "./pilot-schedule";
import { sha256Digest } from "./provenance-crypto";

const AT = [
  "2026-08-30T20:00:00.000Z",
  "2026-08-30T20:00:01.000Z",
  "2026-08-30T20:00:02.000Z",
  "2026-08-30T20:00:03.000Z",
  "2026-08-30T20:00:04.000Z",
];
const digest = (value: string) => sha256Digest(value);
const tasks = [
  { taskId: "architecture-task", taskFamily: "architecture" },
  { taskId: "drawing-task", taskFamily: "drawing" },
];

function runSpec(kind: "aa" | "ab" = "ab"): RunSpec {
  const baseline = { gitCommit: "a".repeat(40), buildDigest: digest("baseline"), deploymentUrl: "https://baseline.test" };
  return {
    schemaVersion: 1,
    runId: `run-${kind}`,
    protocol: { id: "EXP-PILOT", digest: digest("protocol") },
    conditions: {
      baseline,
      candidate: kind === "aa"
        ? { ...baseline, deploymentUrl: "https://candidate-aa.test" }
        : { gitCommit: "b".repeat(40), buildDigest: digest("candidate"), deploymentUrl: "https://candidate.test" },
    },
    runner: { runnerDigest: digest("runner") },
    taskSet: { id: "pilot", version: "v1", split: "development", commitment: digest("task-set") },
    model: { provider: "openai", snapshot: "model", reasoningEffort: "high", temperature: null, seed: null },
    environment: {
      imageDigest: digest("image"),
      browser: "Chromium",
      viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
      locale: "en-US",
      timezone: "UTC",
    },
    budgets: { wallTimeMs: 600_000, maxToolCalls: 200, maxInputTokens: 100_000, maxOutputTokens: 20_000 },
    createdAt: AT[0],
  };
}

function finish(registry: AttemptRegistry, attemptId: string, outcome: "author_completed" | "author_failed" | "timeout" = "author_completed"): AttemptRegistry {
  let next = transitionAttempt(registry, attemptId, "provisioned", AT[1]);
  next = transitionAttempt(next, attemptId, "started", AT[2]);
  next = transitionAttempt(next, attemptId, outcome, AT[3]);
  return sealAttempt(next, attemptId, AT[4], createArtifactIndex(attemptId, []));
}

function acceptance(attemptId: string, accepted: boolean): PilotAcceptanceSummary {
  return {
    attemptId,
    scorerId: "acceptance",
    status: "scored",
    accepted,
    summaryDigest: digest(`acceptance:${attemptId}`),
    errorCode: null,
  };
}

function scorer(attemptId: string, status: "succeeded" | "failed" | "indeterminate" = "succeeded"): PilotScorerSummary {
  return {
    attemptId,
    scorerId: "semantic",
    status,
    summaryDigest: status === "succeeded" ? digest(`semantic:${attemptId}`) : null,
    errorCode: status === "failed" ? "SCORER_CRASH" : null,
  };
}

function completeInput(kind: "aa" | "ab" = "ab"): PilotReportInput {
  const spec = runSpec(kind);
  const schedule = createPilotRandomizationManifest(spec.protocol.id, tasks, 1, 17);
  let registry = initializePilotRegistry(
    spec,
    schedule,
    tasks.map((task) => ({ taskId: task.taskId, commitment: digest(task.taskId) })),
    AT[0],
  );
  for (const attempt of schedule.assignments.flatMap((assignment) => assignment.attempts)) {
    registry = finish(registry, attempt.attemptId);
  }
  return {
    registry,
    schedule,
    acceptanceSummaries: schedule.assignments.flatMap((assignment) => assignment.attempts.map((attempt) =>
      acceptance(attempt.attemptId, attempt.condition === "candidate"))),
    scorerSummaries: schedule.assignments.flatMap((assignment) => assignment.attempts.map((attempt) => scorer(attempt.attemptId))),
    requiredScorerIds: ["semantic"],
    statistics: { bootstrapDraws: 100, seed: 41 },
  };
}

describe("pilot report analysis", () => {
  it("reports a complete A/B paired endpoint and task-family strata without dropping attempts", () => {
    const input = completeInput("ab");
    const report = createPilotReport(input);

    expect(report.integrity.status).toBe("complete");
    expect(report.comparison.kind).toBe("ab_improvement");
    expect(report.improvementClaim).toEqual({ eligibility: "eligible", purpose: "improvement", rejectionReasons: [] });
    expect(report.retention.attempts).toHaveLength(input.schedule.attemptCount);
    expect(report.retention.retainedAttemptCount).toBe(input.schedule.attemptCount);
    expect(report.retention.attempts.every((attempt) => attempt.registryScoringStatus === "unscored" && attempt.retainedScoreRunCount === 0)).toBe(true);
    expect(report.primaryPairedPass).toMatchObject({
      pairCount: 2,
      baselinePassRate: 0,
      candidatePassRate: 1,
      absoluteDifference: 1,
    });
    expect(report.taskFamilyStrata.map((stratum) => stratum.taskFamily)).toEqual(["architecture", "drawing"]);
    expect(report.taskFamilyStrata.every((stratum) => stratum.primaryPairedPass?.pairCount === 1)).toBe(true);
    expect(verifyPilotReport(report, input)).toEqual({ ok: true });
  });

  it("treats missing/failed acceptance and author timeout as retained primary failures", () => {
    const input = completeInput("ab");
    const architecture = input.schedule.assignments.find((assignment) => assignment.taskFamily === "architecture");
    const drawing = input.schedule.assignments.find((assignment) => assignment.taskFamily === "drawing");
    if (!architecture || !drawing) throw new Error("Expected both task families.");
    const architectureCandidate = architecture.attempts.find((attempt) => attempt.condition === "candidate");
    const drawingCandidate = drawing.attempts.find((attempt) => attempt.condition === "candidate");
    if (!architectureCandidate || !drawingCandidate) throw new Error("Expected candidate attempts.");

    input.acceptanceSummaries = input.acceptanceSummaries.filter((summary) => summary.attemptId !== architectureCandidate.attemptId);
    input.acceptanceSummaries = input.acceptanceSummaries.map((summary) => summary.attemptId === drawingCandidate.attemptId ? {
      ...summary,
      status: "failed" as const,
      accepted: null,
      summaryDigest: null,
      errorCode: "JUDGE_TIMEOUT",
    } : summary);
    const report = createPilotReport(input);

    expect(report.integrity.status).toBe("complete");
    expect(report.outcomeAccounting.missingAcceptanceAttemptIds).toEqual([architectureCandidate.attemptId]);
    expect(report.outcomeAccounting.failedAcceptanceAttemptIds).toEqual([drawingCandidate.attemptId]);
    expect(report.primaryPairedPass?.candidateAcceptedCount).toBe(0);
    expect(report.retention.attempts).toHaveLength(4);
  });

  it("reports required scorer failures, indeterminate results, and absences explicitly", () => {
    const input = completeInput("ab");
    const [first, second, third] = input.schedule.assignments.flatMap((assignment) => assignment.attempts);
    input.scorerSummaries = [scorer(first.attemptId, "failed"), scorer(second.attemptId, "indeterminate")];
    const report = createPilotReport(input);

    expect(report.outcomeAccounting.failedScorerSummaries).toEqual([{ attemptId: first.attemptId, scorerId: "semantic", errorCode: "SCORER_CRASH" }]);
    expect(report.outcomeAccounting.indeterminateScorerSummaries).toEqual([{ attemptId: second.attemptId, scorerId: "semantic" }]);
    expect(report.outcomeAccounting.missingRequiredScorerSummaries).toEqual(expect.arrayContaining([
      { attemptId: third.attemptId, scorerId: "semantic" },
    ]));
    expect(report.integrity.status).toBe("complete");
  });

  it("always rejects an improvement claim for A/A calibration, even with apparent lift", () => {
    const report = createPilotReport(completeInput("aa"));
    expect(report.comparison.kind).toBe("aa_calibration");
    expect(report.primaryPairedPass?.absoluteDifference).toBe(1);
    expect(report.improvementClaim).toMatchObject({
      eligibility: "rejected",
      purpose: "calibration_only",
      rejectionReasons: ["AA_CALIBRATION_CANNOT_SUPPORT_IMPROVEMENT_CLAIM"],
    });
  });

  it("rejects claims and withholds paired statistics for incomplete or invalid registries", () => {
    const incomplete = completeInput("ab");
    let incompleteRegistry = initializePilotRegistry(
      incomplete.registry.runSpec,
      incomplete.schedule,
      tasks.map((task) => ({ taskId: task.taskId, commitment: digest(task.taskId) })),
      AT[0],
    );
    const allAttempts = incomplete.schedule.assignments.flatMap((assignment) => assignment.attempts);
    for (const attempt of allAttempts.slice(0, -1)) incompleteRegistry = finish(incompleteRegistry, attempt.attemptId);
    incomplete.registry = incompleteRegistry;
    const incompleteReport = createPilotReport(incomplete);
    expect(incompleteReport.integrity.status).toBe("incomplete");
    expect(incompleteReport.primaryPairedPass).toBeNull();
    expect(incompleteReport.improvementClaim).toMatchObject({ eligibility: "rejected" });
    expect(incompleteReport.improvementClaim.rejectionReasons).toContain("INCOMPLETE_ALL_ATTEMPT_REGISTRY");
    expect(incompleteReport.retention.attempts.some((attempt) => attempt.disposition === "unfinished")).toBe(true);

    const invalid = completeInput("ab");
    invalid.registry = structuredClone(invalid.registry);
    invalid.registry.attempts[0].condition = invalid.registry.attempts[0].condition === "baseline" ? "candidate" : "baseline";
    const invalidReport = createPilotReport(invalid);
    expect(invalidReport.integrity.status).toBe("invalid");
    expect(invalidReport.primaryPairedPass).toBeNull();
    expect(invalidReport.improvementClaim.rejectionReasons).toContain("INVALID_PILOT_EVIDENCE");
  });

  it("is deterministic and detects report or input tampering", () => {
    const input = completeInput("ab");
    const first = createPilotReport(input);
    const second = createPilotReport({
      ...input,
      acceptanceSummaries: [...input.acceptanceSummaries].reverse(),
      scorerSummaries: [...input.scorerSummaries].reverse(),
    });
    expect(first).toEqual(second);

    const tampered = structuredClone(first);
    tampered.retention.attempts[0].effectiveAccepted = !tampered.retention.attempts[0].effectiveAccepted;
    expect(verifyPilotReport(tampered, input)).toMatchObject({ ok: false });
    expect(verifyPilotReport(first, { ...input, requiredScorerIds: ["semantic", "visual"] })).toMatchObject({ ok: false });
  });
});
